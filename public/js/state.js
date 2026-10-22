/* state.js — 單一狀態倉；snapshot 覆蓋、tick 更新、event 堆疊。
   所有顯示金額直接取自伺服器整數欄位（contract 命名），不在這裡計算資產。 */

export const state = {
  isMock: false,
  userId: '1',
  user: null,          // M3：登入使用者（/api/me 或 mock 預載；contract user 形狀）
  devAuth: false,      // M3：/api/me 的 dev_auth → true 時 ?user= 才生效
  config: null,          // GET /api/config（mock 用相同形狀的常數）

  serverNow: Date.now(), // 每個訊息對齊 server_time
  clockSkew: 0,
  tickId: 0,

  market: {
    price_e4: null,
    base_price_e4: null,
    impact: 0,
    net_notional_milli: 0,
    L_milli: null,
  },
  account: {
    balance_milli: null,
    available_milli: null,
    equity_milli: null,
    margin_milli: null,
    settled_tick_id: 0,
  },
  positions: [],        // Position[]（open）

  candles: [],          // 已收盤 1 分 K，舊→新；含 started_at/minute_id/…/net_notional_milli
  forming: null,        // 未收盤的當前 1 分 K（client 依 tick 維護）
  events: [],           // 新→舊，最多 100

  priceDir: 0,          // 最後一 tick 方向：1 上 / -1 下 / 0 平
  connectedOnce: false,

  // UI（非 contract 資料）
  ui: {
    chartMode: 'line',     // line | m1 | m5
    chartRange: 60,        // 顯示區間（分鐘）：60 / 240 / 600
    newsOpen: true,
    focusEventTickId: null,
    crosshair: null,
  },
  pendingOrders: new Map(), // request_id → { side, ... }（凍結列入 pending）

  // 自動再下單（M2 後端無此欄位 → client 計數呈現）
  reentry: { enabled: false, count: 0 },
};

/* ── 訊息接應 ─────────────────────────────── */

export function applySnapshot(data, { replaceCandles = false } = {}) {
  state.serverNow = Date.parse(data.server_time) || Date.now();
  state.clockSkew = state.serverNow - Date.now();
  state.tickId = data.tick_id;

  if (data.market) Object.assign(state.market, data.market);
  if (data.account) Object.assign(state.account, data.account);
  state.positions = (data.positions || []).filter(p => p.status === 'open');

  if (replaceCandles || (Array.isArray(data.candles) && data.candles.length)) {
    setCandles(data.candles || []);
  }
  if (Array.isArray(data.events) && data.events.length) {
    state.events = data.events.slice(0, 100);
  }
  state.connectedOnce = true;
}

export function applyTick(data) {
  state.serverNow = Date.parse(data.server_time) || state.serverNow;
  state.clockSkew = state.serverNow - Date.now();
  state.tickId = data.tick_id;

  const prev = state.market.price_e4;
  if (data.market) Object.assign(state.market, data.market);
  if (state.market.L_milli == null && data.market && data.market.base_price_e4 != null) {
    // tick 訊息無 L_milli（contract），沿用最後已知值
  }
  state.priceDir = prev == null ? 0 : (state.market.price_e4 > prev ? 1 : state.market.price_e4 < prev ? -1 : state.priceDir);

  if (data.account) Object.assign(state.account, data.account);
  if (data.positions) state.positions = data.positions.filter(p => p.status === 'open');

  // 先封舊分鐘，再把這一 tick 計入新 forming，避免分鐘邊界那一秒被算進舊 K
  maybeCloseMinute();
  advanceForming();
}

export function applyEventMessage(ev) {
  if (state.events.some(e => e.id === ev.id)) return;
  state.events = [ev, ...state.events].slice(0, 100);
}

export function setCandles(list) {
  // 只留已過去分鐘的完整 K；最新一根若對上現在分鐘，視為 forming
  const nowMin = Math.floor(state.serverNow / 60000);
  const currentMinuteId = Math.floor((Number.isFinite(state.tickId) ? state.tickId : 0) / 60);
  const closed = [];
  let forming = null;
  for (const c of list) {
    if (c.minute_id != null) {
      if (c.minute_id >= currentMinuteId) { forming = c; continue; }
      closed.push(c);
      continue;
    }
    // 舊資料沒有 minute_id → 退回以 started_at 判斷
    const t = c.started_at ? Date.parse(c.started_at) : null;
    const m = t ? Math.floor(t / 60000) : null;
    if (m != null && m >= nowMin) { forming = c; continue; }
    closed.push(c);
  }
  // 重連 snapshot 可能只帶最近 60 根 → 與既有歷史合併，避免 K 線歷史被截短
  const byId = new Map(state.candles.map(c => [c.minute_id, c]));
  for (const c of closed) byId.set(c.minute_id, c);
  state.candles = [...byId.values()]
    .filter(c => c.minute_id != null)
    .sort((a, b) => a.minute_id - b.minute_id)
    .slice(-600);
  state.forming = forming || null;
}

export function pushClosedCandle(c) {
  if (c.minute_id == null) return;
  const i = state.candles.findIndex(x => x.minute_id === c.minute_id);
  if (i >= 0) state.candles[i] = c;
  else state.candles.push(c);
  state.candles.sort((a, b) => a.minute_id - b.minute_id);
  if (state.candles.length > 600) state.candles.shift();
  state.forming = null;
}

/** 每秒 tick：維護 forming K（未收盤僅更新 close/high/low，不長新 K） */
export function advanceForming() {
  const tickId = Number.isFinite(state.tickId) ? state.tickId : 0;
  const currentMinuteId = Math.floor(tickId / 60);
  const currentMinuteStart = state.serverNow - (tickId % 60) * 1000;

  if (!state.forming) {
    const last = state.candles[state.candles.length - 1];
    const p = state.market.price_e4;
    if (p == null) return;
    const mid = last && Number.isFinite(last.minute_id) ? last.minute_id + 1 : currentMinuteId;
    let started = currentMinuteStart - (currentMinuteId - mid) * 60000;
    if (started > state.serverNow) started = state.serverNow;
    state.forming = {
      minute_id: mid,
      started_at: new Date(started).toISOString(),
      open_e4: last ? (last.close_e4 ?? last.open_e4) : p,
      high_e4: p, low_e4: p, close_e4: p,
      base_close_e4: last ? last.base_close_e4 : p,
      net_notional_milli: state.market.net_notional_milli || 0,
    };
  }

  const p = state.market.price_e4;
  if (p != null) {
    if (p > state.forming.high_e4) state.forming.high_e4 = p;
    if (p < state.forming.low_e4) state.forming.low_e4 = p;
    state.forming.close_e4 = p;
  }
  state.forming.net_notional_milli = state.market.net_notional_milli ?? state.forming.net_notional_milli;
}

/** 分鐘邊界：將 forming 封存為已收 K（以伺服器 tickId 的分鐘歸屬判定） */
export function maybeCloseMinute() {
  if (!state.forming) return;
  const currentMinuteId = Math.floor((Number.isFinite(state.tickId) ? state.tickId : 0) / 60);
  const mid = state.forming.minute_id;
  const legacyCloses = mid == null
    && Math.floor((Date.parse(state.forming.started_at) || 0) / 60000) < Math.floor(state.serverNow / 60000);
  if ((mid != null && mid < currentMinuteId) || legacyCloses) {
    pushClosedCandle(state.forming);
    state.forming = null;
    advanceForming();
  }
}

/* 事件時間推導：ticks 為 1 秒一格 → event 時刻 = serverNow − (curTick − ev.tick_id)s */
export function eventTimeMs(ev) {
  return state.serverNow - Math.max(0, state.tickId - ev.tick_id) * 1000;
}

/* 取圖表資料視圖（依模式） */
export function chartData() {
  const mode = state.ui.chartMode;
  const candles = state.candles;
  if (mode === 'line') {
    const raw = candles
      .filter(c => c.close_e4 != null)
      .map(c => ({ t: candleTimeMS(c), v: c.close_e4 }));
    if (state.market.price_e4 != null) {
      raw.push({ t: state.serverNow, v: state.market.price_e4, live: true });
    }
    // 以時間排序並去重：避免舊／新 K 混用時折線來回折，看起來像好幾條線
    const byT = new Map();
    for (const p of raw) byT.set(p.t, p);
    return { points: [...byT.values()].sort((a, b) => a.t - b.t) };
  }
  // K 線：1 或 5 分聚合
  const src = [...candles];
  if (state.forming) src.push(state.forming);
  if (mode === 'm5') {
    const groups = new Map();
    for (const c of src) {
      const t = candleTimeMS(c);
      const key = Math.floor(t / (5 * 60000));
      const g = groups.get(key);
      if (!g) groups.set(key, { t: key * 5 * 60000, open_e4: c.open_e4, high_e4: c.high_e4, low_e4: c.low_e4, close_e4: c.close_e4 });
      else {
        g.high_e4 = Math.max(g.high_e4, c.high_e4);
        g.low_e4 = Math.min(g.low_e4, c.low_e4);
        g.close_e4 = c.close_e4;
      }
    }
    return { candles5: [...groups.values()].sort((a, b) => a.t - b.t) };
  }
  return { candles1: src.map(c => ({ ...c, t: candleTimeMS(c) })).sort((a, b) => a.t - b.t).slice(-600) };
}

export function candleTimeMS(c, i = 0) {
  if (c.started_at) {
    const t = Date.parse(c.started_at);
    if (Number.isFinite(t)) return t;
  }
  // M1 舊資料沒有 started_at → 用 minute_id 對齊目前 tick／serverNow，避免所有 K 擠在同一點
  const tickId = Number.isFinite(state.tickId) ? state.tickId : 0;
  const currentMinuteId = Math.floor(tickId / 60);
  const currentMinuteStart = state.serverNow - (tickId % 60) * 1000;
  const mid = c.minute_id ?? (currentMinuteId - (state.candles.length - 1 - i));
  return currentMinuteStart - (currentMinuteId - mid) * 60000;
}

export function netNotionalSeries() {
  const arr = state.candles.map(c => c.net_notional_milli ?? 0);
  arr.push(state.market.net_notional_milli ?? 0);
  return arr;
}
