/* mock.js — ?mock=1 用的本地模擬伺服器。
   產出的訊息形狀與 contract 完全一致（snapshot / tick / order.filled /
   order.rejected / liquidation / event），讓交易頁可獨立檢視。
   金額一律整數 milli-A、價格整數 e4，不由顯示層計算。 */

const LEVERAGES = [1, 2, 5, 10, 20, 50, 100];
const MIN_MARGIN_A = { 1: 10000, 2: 5000, 5: 2000, 10: 1000, 20: 500, 50: 200, 100: 100 };
const MAX_POSITIONS = 5;
const MIN_NOTIONAL_A = 10000;
const SPREAD = 0.0002;
const FEE_LONG_ANNUAL = 0.026;
const FEE_SHORT_ANNUAL = 0.009;
const MAINT_RATE = 0.002;
const L_MILLI = 3000000000;
const START_BAL_MILLI = 100000000; // 100,000 A

const HEADLINES = [
  '央行意外升息半碼', '出口數據不如預期', '外資大舉匯入', '油價跌破關鍵價位',
  '地緣衝突升溫', '面板需求回升', '主要科技財報超出市場預期', '供應鏈傳出缺料',
  '疫情後需求回穩', '關鍵產區地震造成停工', '國際航運運價急漲', '通膨數據高於預期',
];

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function createMockServer() {
  const now = Date.now();
  let tick = 43200;                       // 對齊「小時」感的 tick_id
  let price = 5.0000;                     // A/B，浮點內部值
  let anchor = 5.0000;
  let netNotional = 0;
  const positions = [];
  const events = [];
  let posSeq = 1;
  let evSeq = 1;
  let nextEventIn = 40 + Math.random() * 120;
  const clients = new Set();
  let timer = null;

  /* ── 初始 60 根 1 分 K ── */
  const candles = [];
  {
    let p = price;
    for (let i = 59; i >= 0; i--) {
      const open = p;
      let hi = open, lo = open, close = open;
      for (let k = 0; k < 4; k++) {
        close *= 1 + gauss() * 0.0006;
        hi = Math.max(hi, close); lo = Math.min(lo, close);
      }
      netNotional = netNotional * 0.94 + gauss() * 12e6;
      const started = new Date(now - i * 60000 - 60000);
      candles.push({
        minute_id: 1200 - i - 1,
        started_at: new Date(started.getTime()).toISOString(),
        open_e4: Math.round(open * 10000),
        high_e4: Math.round(hi * 10000),
        low_e4: Math.round(lo * 10000),
        close_e4: Math.round(close * 10000),
        base_close_e4: Math.round(close * 10000),
        net_notional_milli: Math.round(netNotional),
        volume_notional_milli: Math.round(Math.abs(netNotional) * 0.02),
      });
      p = close;
    }
    price = p;
  }

  /* ── 種子事件（過去一小時內數則） ── */
  const seedJumps = [0.023, -0.006, 0.004, -0.019, 0.002, -0.002];
  seedJumps.forEach((j, idx) => {
    const tid = tick - (7 + idx * 9) * 60; // 分鐘級散佈
    events.push({
      id: evSeq++,
      tick_id: tid,
      headline: HEADLINES[(idx * 5) % HEADLINES.length],
      impact_jump: j,
    });
  });

  function simTick() {
    tick++;
    // OU 回歸 + 1 分鐘級噪聲（ticks = 秒）
    if (tick % 60 === 1) anchor = anchor * 0.995 + price * 0.005;
    let ret = -0.00008 * (price - anchor) / anchor + gauss() * 0.00055;

    // 事件
    nextEventIn--;
    if (nextEventIn <= 0) {
      nextEventIn = 70 + Math.random() * 150;
      const big = Math.random() < 0.35;
      const jump = big ? (Math.random() < 0.5 ? 1 : -1) * (0.015 + Math.random() * 0.03)
        : (Math.random() < 0.5 ? 1 : -1) * (0.002 + Math.random() * 0.008);
      const ev = {
        id: evSeq++,
        tick_id: tick,
        headline: HEADLINES[Math.floor(Math.random() * HEADLINES.length)],
        impact_jump: Math.round(jump * 10000) / 10000,
      };
      events.unshift(ev);
      if (events.length > 100) events.pop();
      price *= 1 + ev.impact_jump;
      ret = 0;
      broadcast({ type: 'event', data: ev });
    }

    price *= 1 + ret;
    price = Math.min(Math.max(price, 0.5), 50);

    // 淨部位緩慢回歸
    netNotional = netNotional * 0.98 + (positions.reduce((s, p) => s + (p.side === 'long' ? p.notional_milli : -p.notional_milli), 0)) * 0.02;

    // 持倉損益
    const price_e4 = Math.round(price * 10000);
    for (const pos of positions) {
      const mark = pos.side === 'long' ? price : price * (1 - SPREAD);
      const dir = pos.side === 'long' ? 1 : -1;
      pos.pnl_milli = Math.round(pos.notional_milli * dir * (mark * 10000 - pos.entry_price_e4) / pos.entry_price_e4);
    }

    // 分鐘封存
    const t = Date.now();
    const cur = new Date(t - t % 60000);
    const closedNow = candles[candles.length - 1];
    const forming = getForming();
    const curMin = Math.floor(t / 60000);

    forming.close_e4 = price_e4;
    forming.high_e4 = Math.max(forming.high_e4, price_e4);
    forming.low_e4 = Math.min(forming.low_e4, price_e4);
    forming.net_notional_milli = Math.round(netNotional);

    if (Math.floor(Date.parse(closedNow.started_at || closedNow.started) / 60000) < curMin) {
      candles.push({ ...forming, base_close_e4: forming.close_e4 - Math.round(gauss() * 12) });
      if (candles.length > 600) candles.shift();
      // 新形成 K
      mockForming = {
        minute_id: (forming.minute_id || 0) + 1,
        started_at: cur.toISOString(),
        open_e4: forming.close_e4,
        high_e4: forming.close_e4, low_e4: forming.close_e4, close_e4: forming.close_e4,
        base_close_e4: forming.base_close_e4,
        net_notional_milli: Math.round(netNotional),
      };
    }

    // 強平檢查（價格穿越強平價）
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      const hit = pos.side === 'long' ? price <= pos.liq_price_e4 / 10000 : price >= pos.liq_price_e4 / 10000;
      if (hit) {
        positions.splice(i, 1);
        const pnl = -Math.round(pos.margin_milli * 0.8); // 維持 80%：吞掉 80% 保證金，剩 20% 回可用
        balanceMilli += pos.margin_milli + pnl;          // 已用保證金退回 + 強平損
        broadcast({
          type: 'liquidation',
          data: { position_id: pos.id, price_e4: price_e4, pnl_milli: pnl },
        });
      }
    }

    broadcast({
      type: 'tick',
      data: {
        server_time: new Date().toISOString(),
        tick_id: tick,
        market: {
          price_e4: price_e4,
          base_price_e4: Math.round(anchor * 10000),
          impact: 0,
          net_notional_milli: Math.round(netNotional),
        },
        account: accountMsg(),
        positions: positions.map(p => ({ ...p })),
      },
    });
  }

  let mockForming = null;
  function getForming() {
    if (!mockForming) {
      const last = candles[candles.length - 1];
      mockForming = {
        minute_id: last.minute_id + 1,
        started_at: new Date(Date.now() - Date.now() % 60000).toISOString(),
        open_e4: last.close_e4, high_e4: last.close_e4, low_e4: last.close_e4, close_e4: last.close_e4,
        base_close_e4: last.close_e4,
        net_notional_milli: Math.round(netNotional),
      };
    }
    return mockForming;
  }

  function accountMsg() {
    const marginMilli = positions.reduce((s, p) => s + p.margin_milli, 0);
    const floatPnl = positions.reduce((s, p) => s + p.pnl_milli, 0);
    return {
      balance_milli: balanceMilli,
      available_milli: balanceMilli - marginMilli,
      equity_milli: balanceMilli + floatPnl,
      margin_milli: marginMilli,
      settled_tick_id: 0,
    };
  }
  let balanceMilli = START_BAL_MILLI;

  function snapshotMsg() {
    return {
      type: 'snapshot',
      data: {
        server_time: new Date().toISOString(),
        tick_id: tick,
        market: {
          price_e4: Math.round(price * 10000),
          base_price_e4: Math.round(anchor * 10000),
          impact: 0,
          net_notional_milli: Math.round(netNotional),
          L_milli: L_MILLI,
        },
        account: accountMsg(),
        positions: positions.map(p => ({ ...p })),
        candles: [...candles, mockForming].filter(Boolean),
        events: [...events],
      },
    };
  }

  function broadcast(msg) {
    for (const cb of clients) { try { cb(msg); } catch { /* noop */ } }
  }

  /* ── 訂單處理 ── */
  function handle(msg, session) {
    const reply = m => session.cb(m);
    const data = msg.data || {};

    if (msg.type === 'ping') { reply({ type: 'pong' }); return; }

    if (msg.type === 'order.open') {
      const lev = Number(data.leverage);
      const marginAPure = Number(data.margin_a);
      const marginMilli = Math.round(marginAPure * 1000);
      const side = data.side === 'short' ? 'short' : 'long';
      const notionalMilli = marginMilli * lev;

      const reject = reason => {
        reply({ type: 'order.rejected', request_id: msg.request_id, data: { reason } });
        broadcastTickSoon();
      };

      if (!LEVERAGES.includes(lev)) return reject('invalid_leverage');
      if (side !== 'long' && side !== 'short') return reject('invalid_side');
      const acct = accountMsg();
      if (marginAPure < MIN_MARGIN_A[lev]) return reject('min_notional');
      if (notionalMilli < MIN_NOTIONAL_A * 1000) return reject('min_notional');
      if (positions.length >= MAX_POSITIONS) return reject('max_positions');
      if (marginMilli > acct.available_milli) return reject('insufficient_balance');
      if (acct.available_milli <= 0) return reject('debt_no_open');

      // 名目上限 min(2L, available×lev)：超過 → 依 contract 可截斷（ok:true + truncated:true）
      const maxNotionalMilli = Math.min(2 * L_MILLI, acct.available_milli * lev);
      let marginEff = marginMilli;
      let notionalEff = marginMilli * lev;
      let truncated = false;
      if (notionalEff > maxNotionalMilli) {
        const maxMarginA = Math.floor((maxNotionalMilli / lev) / 1000 / 10) * 10; // A，步進 10
        marginEff = maxMarginA * 1000;
        notionalEff = marginEff * lev;
        truncated = true;
        if (Math.round(marginEff / 1000) < MIN_MARGIN_A[lev]) return reject('min_notional');
      }

      const fillPrice_e4 = Math.round(price * (1 + (side === 'long' ? SPREAD : -SPREAD)) * 10000);
      const liqDist = 1 / lev - MAINT_RATE;
      const dirMarker = side === 'long' ? -1 : 1;
      const pos = {
        id: posSeq++,
        side,
        notional_milli: notionalEff,
        leverage: lev,
        entry_price_e4: fillPrice_e4,
        margin_milli: marginEff,
        liq_price_e4: Math.round(fillPrice_e4 * (1 + dirMarker * liqDist)),
        // sl_pct/tp_pct 為 % 數字（0.5 = 0.5%，contract 定案）
        sl_price_e4: data.sl_pct ? Math.round(fillPrice_e4 * (1 + dirMarker * Number(data.sl_pct) / 100)) : null,
        tp_price_e4: data.tp_pct ? Math.round(fillPrice_e4 * (1 - dirMarker * Number(data.tp_pct) / 100)) : null,
        pnl_milli: 0,
        status: 'open',
      };
      positions.push(pos);
      simTickNow(); // 立刻給 tick（真實伺服器也是下一 tick 結算）
      const fillMsg = { price_e4: fillPrice_e4, notional_milli: notionalEff, margin_milli: marginEff };
      if (truncated) fillMsg.truncated = true;
      reply({
        type: 'order.filled',
        request_id: msg.request_id,
        data: {
          side,
          position: { ...pos },
          fill: fillMsg,
        },
      });
      return;
    }

    if (msg.type === 'order.close') {
      const idx = positions.findIndex(p => p.id === Number(data.position_id));
      if (idx < 0) return reply({ type: 'order.rejected', request_id: msg.request_id, data: { reason: 'not_found' } });
      const pos = positions[idx];
      const exit = price * (1 + (pos.side === 'long' ? -SPREAD : SPREAD));
      const exit_e4 = Math.round(exit * 10000);
      const dir = pos.side === 'long' ? 1 : -1;
      // pnl 一律以 e4 價差比例乘名目（毫 A）：notional × (exit_e4 − entry_e4) / entry_e4
      const pnl = Math.round(pos.notional_milli * dir * (exit_e4 - pos.entry_price_e4) / pos.entry_price_e4);
      positions.splice(idx, 1);
      reply({ type: 'order.filled', request_id: msg.request_id, data: {
        side: pos.side,
        position: { ...pos, status: 'closed', pnl_milli: pnl },
        fill: { price_e4: exit_e4, notional_milli: pos.notional_milli, margin_milli: 0 },
        exit_price_e4: exit_e4,
        pnl_milli: pnl,
      } });
      simTickNow();
      return;
    }
  }

  function broadcastTickSoon() {
    simTickNow();
  }

  function simTickNow() { simTick(); } // mock 直接同步觸發一次（真實伺服器為 1s 週期）

  /* ── client 介面 ── */
  return {
    attach(cb) {
      clients.add(cb);
      if (!timer) timer = setInterval(simTick, 1000);
      let resolveReady;
      const ready = new Promise(r => { resolveReady = r; });
      const session = { cb, ready };
      // 下一個 microtask 送 snapshot（模擬 handshake）
      queueMicrotask(() => { cb(snapshotMsg()); resolveReady(); });
      return session;
    },
    handle,
    detach(session) {
      clients.delete(session.cb);
      if (!clients.size && timer) { clearInterval(timer); timer = null; }
    },
  };
}
