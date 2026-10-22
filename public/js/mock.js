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

export function createMockServer(opts = {}) {
  const now = Date.now();
  const forceReportKind = (opts && opts.forceReport) || null; // ?report=1（正常）/ =liq（含強平）：首連線強制回報
  let forceReportServed = false;
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

  /* ── M3：條件單＋離線報告狀態 ── */
  const rules = [];                 // Rule[]（contract 形狀＋內部 _fillTick）
  let ruleSeq = 1;
  let lastSeenTick = null;          // 上次 detach 時 tick（離線期起點）
  let lastSeenWall = null;          // detach 牆鐘
  let lastSeenEquity = null;
  let eqStart = null;               // 本次 attach 後淨值基準
  let eqHigh = null, eqLow = null;  // attach 期間淨值高低
  let incomeMilli = 0;              // attach 期間已實現損益（平倉＋強平）

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
        incomeMilli += pnl;
        pauseRulesOnLiquidation();                       // M3：強平 → 暫停全部生效中條件單
        broadcast({
          type: 'liquidation',
          data: { position_id: pos.id, price_e4: price_e4, pnl_milli: pnl },
        });
      }
    }

    // ── M3 rule fills（liquidations → SL/TP → rule fills；成交在觸發 tick 的下一 tick） ──
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (r._fillTick !== tick) continue;
      fillRuleNow(r);
    }

    // ── M3 trigger 評估（本 tick 最後價格；命中 → 排定下一 tick 成交） ──
    for (const r of rules) {
      if (r.status !== 'active' || r.enabled === false || r._fillTick != null) continue;
      const trig = r.trigger_price_e4 / 10000;
      const hit = r.armed_side === 'above' ? price >= trig : price <= trig;
      if (hit) r._fillTick = tick + 1;
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
        account: broadcastAccount(),
        positions: positions.map(p => ({ ...p })),
      },
    });
  }

  /* 淨值統計（離線報告用）：attach 期間高低點 */
  function broadcastAccount() {
    const a = accountMsg();
    if (a.equity_milli > (eqHigh ?? -Infinity)) eqHigh = a.equity_milli;
    if (a.equity_milli < (eqLow ?? Infinity)) eqLow = a.equity_milli;
    return a;
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

  /* ══ M3：條件單引擎 ═════════════════════════════════ */
  function serializeRule(r) {
    const pub = { ...r };
    delete pub._fillTick;
    delete pub._lastNotifiedTick;
    return pub;
  }

  function validateRuleData(d) {
    if (d.side !== 'long' && d.side !== 'short') return 'invalid_side';
    if (!LEVERAGES.includes(Number(d.leverage))) return 'invalid_leverage';
    const minA = MIN_MARGIN_A[Number(d.leverage)] || 1000;
    if (!(Number(d.margin_a) >= minA)) return 'invalid_margin';
    const trig = Number(d.trigger_price_e4);
    if (!(trig > 0)) return 'invalid_trigger';
    if (Math.round(Number(d.margin_a) * 1000) > accountMsg().available_milli) return 'insufficient_margin';
    const gap = Math.abs(trig / 10000 - price) / price;
    if (gap < 0.0005) return 'trigger_too_close'; // 觸發價貼現價 <0.05%（優先於上限，安全反饋）
    if (rules.filter(r => r.status === 'active' && r.enabled !== false).length >= 2) return 'max_active_rules';
    return null;
  }

  /** 成交嘗試（觸發 tick 的下一 tick 以市價成交；失敗不停用規則，僅記 last_error） */
  function fillRuleNow(r) {
    r._fillTick = null;
    const fail = reason => {
      r.last_error = reason;
      const due = r._lastNotifiedTick == null || tick - r._lastNotifiedTick >= 300; // 最多 5 分鐘一次
      if (due) {
        r._lastNotifiedTick = tick;
        broadcast({ type: 'rule.skipped', data: { rule_id: r.id, reason } });
        broadcast({ type: 'rule.updated', data: serializeRule(r) });
      }
    };
    const lev = Number(r.leverage);
    const marginMilli = Math.round(Number(r.margin_a) * 1000);
    const acct = accountMsg();
    if (marginMilli > acct.available_milli) return fail('insufficient_balance');
    if (positions.length >= MAX_POSITIONS) return fail('max_positions');
    if (acct.available_milli <= 0) return fail('debt_no_open');

    const side = r.side;
    // 合約：買——下一價 > 觸發價 → 成交 = 下一價 ×1.001；賣——下一價 < 觸發價 → ×0.999
    const trig = r.trigger_price_e4 / 10000;
    const worse = side === 'long' ? price > trig : price < trig;
    const fill = price * (worse ? (side === 'long' ? 1.001 : 0.999) : 1);
    const fill_e4 = Math.round(fill * 10000);
    const liqDist = 1 / lev - MAINT_RATE;
    const dirMarker = side === 'long' ? -1 : 1;
    const pos = {
      id: posSeq++,
      side,
      notional_milli: marginMilli * lev,
      leverage: lev,
      entry_price_e4: fill_e4,
      margin_milli: marginMilli,
      liq_price_e4: Math.round(fill * (1 + dirMarker * liqDist) * 10000),
      sl_price_e4: r.sl_pct ? Math.round(fill * (1 + dirMarker * Number(r.sl_pct) / 100) * 10000) : null,
      tp_price_e4: r.tp_pct ? Math.round(fill * (1 - dirMarker * Number(r.tp_pct) / 100) * 10000) : null,
      pnl_milli: 0,
      status: 'open',
    };
    positions.push(pos);
    r.status = 'triggered';
    r.triggered_tick = tick;
    r.last_error = null;
    broadcast({
      type: 'rule.triggered',
      data: { rule_id: r.id, position_id: pos.id, side, fill_price_e4: fill_e4, notional_milli: pos.notional_milli },
    });
    broadcast({ type: 'rule.updated', data: serializeRule(r) });
  }

  /** 強平 → 暫停該使用者全部生效中條件單（paused_reason='liquidation'，需手動恢復） */
  function pauseRulesOnLiquidation() {
    for (const r of rules) {
      if (r.status === 'active') {
        r.status = 'paused';
        r.paused_reason = 'liquidation';
        r._fillTick = null;
        broadcast({ type: 'rule.updated', data: serializeRule(r) });
      }
    }
  }

  /** 離線報告：GET /api/report（以 server 端 last_seen_tick 計算離線期間；唯讀） */
  function buildReport() {
    const equity = accountMsg().equity_milli;
    if (forceReportKind && !forceReportServed) {
      forceReportServed = true;
      const liq = forceReportKind === 'liq';
      return {
        since_tick: tick - 3600,
        until_tick: tick,
        offline_seconds: 3600,
        income_milli: liq ? -2150000 : 1260000,
        equity_start_milli: 100000000,
        equity_end_milli: liq ? 78500000 : 100350000,
        equity_high_milli: liq ? 100420000 : 101100000,
        equity_low_milli: liq ? 78500000 : 99850000,
        liquidated: liq,
        triggers: liq ? [
          { rule_id: 3, kind: 'open', tick_id: tick - 2500, side: 'long', price_e4: 50120, notional_milli: 10000000, pnl_milli: null },
          { rule_id: 3, kind: 'liquidation', tick_id: tick - 300, side: 'long', price_e4: 45860, notional_milli: 10000000, pnl_milli: -2150000 },
        ] : [
          { rule_id: 3, kind: 'open', tick_id: tick - 2500, side: 'long', price_e4: 50120, notional_milli: 10000000, pnl_milli: null },
          { rule_id: 3, kind: 'tp', tick_id: tick - 1900, side: 'long', price_e4: 50620, notional_milli: 10000000, pnl_milli: 990000 },
          { rule_id: 4, kind: 'skipped', tick_id: tick - 800, side: null, price_e4: null, notional_milli: null, pnl_milli: null, reason: 'insufficient_balance' },
        ],
      };
    }
    return {
      since_tick: lastSeenTick != null ? lastSeenTick : tick,
      until_tick: tick,
      offline_seconds: lastSeenWall != null ? Math.max(0, Math.round((Date.now() - lastSeenWall) / 1000)) : 0,
      income_milli: Math.round(incomeMilli),
      equity_start_milli: eqStart != null ? eqStart : equity,
      equity_end_milli: equity,
      equity_high_milli: eqHigh != null ? Math.max(eqHigh, equity) : equity,
      equity_low_milli: eqLow != null ? Math.min(eqLow, equity) : equity,
      liquidated: false, // 離線期間 mock 市場不跳動，不會有離線強平；?report=liq 可演示紅色警示
      triggers: [],
    };
  }

  /** mock REST shim：契約 REST 端點由模擬伺服器代答（不經 fetch） */
  function handleRest(path, method = 'GET', body = {}) {
    if (method === 'GET' && path.startsWith('/api/rules')) {
      return { max_active: 2, rules: rules.map(serializeRule) };
    }
    const m = path.match(/^\/api\/rules\/(\d+)$/);
    if (m && method === 'PATCH') {
      const r = rules.find(x => x.id === Number(m[1]));
      if (!r) return { ok: false, reason: 'invalid_trigger' };
      if (r.status === 'triggered' || r.status === 'cancelled') return { ok: false, reason: 'invalid_trigger' };
      if (body.enabled === true) {
        const actives = rules.filter(x => x.status === 'active' && x.id !== r.id).length;
        if (actives >= 2) return { ok: false, reason: 'max_active_rules' };
        r.status = 'active';
        r.enabled = true;
        r.last_error = null;
        r.paused_reason = null;
      } else if (body.enabled === false) {
        r.enabled = false;
        r.status = 'paused';
        r.paused_reason = 'manual';
        r._fillTick = null;
      }
      broadcast({ type: 'rule.updated', data: serializeRule(r) });
      return { ok: true, rule: serializeRule(r) };
    }
    if (m && method === 'DELETE') {
      const r = rules.find(x => x.id === Number(m[1]));
      if (r) {
        r.status = 'cancelled';
        r._fillTick = null;
        broadcast({ type: 'rule.updated', data: serializeRule(r) });
      }
      return { ok: true };
    }
    if (path === '/api/report' && method === 'GET') return buildReport();
    if (path === '/api/report/ack' && method === 'POST') return { ok: true };
    return { ok: false, reason: 'not_found' };
  }

  /* ── 訂單處理 ── */
  function handle(msg, session) {
    const reply = m => session.cb(m);
    const data = msg.data || {};

    if (msg.type === 'ping') { reply({ type: 'pong' }); return; }

    /* ── M3：條件單 WS（rule.upsert / rule.delete；回覆 rule.updated / rule.rejected） ── */
    if (msg.type === 'rule.upsert') {
      const reason = validateRuleData(data);
      if (reason) return reply({ type: 'rule.rejected', request_id: msg.request_id, data: { reason } });
      const trig = Number(data.trigger_price_e4);
      const rule = {
        id: ruleSeq++,
        kind: 'conditional_open',
        side: data.side,
        trigger_price_e4: trig,
        margin_a: Number(data.margin_a),
        leverage: Number(data.leverage),
        sl_pct: data.sl_pct != null ? Number(data.sl_pct) : null,
        tp_pct: data.tp_pct != null ? Number(data.tp_pct) : null,
        enabled: true,
        status: 'active',
        armed_side: trig / 10000 > price ? 'above' : 'below',
        created_tick: tick,
        triggered_tick: null,
        last_error: null,
      };
      rules.push(rule);
      reply({ type: 'rule.updated', request_id: msg.request_id, data: serializeRule(rule) });
      return;
    }

    if (msg.type === 'rule.delete') {
      const r = rules.find(x => x.id === Number(data.rule_id));
      if (!r) return reply({ type: 'rule.rejected', request_id: msg.request_id, data: { reason: 'invalid_trigger' } });
      r.status = 'cancelled';
      r._fillTick = null;
      reply({ type: 'rule.updated', request_id: msg.request_id, data: serializeRule(r) });
      return;
    }

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
      incomeMilli += pnl; // 離線報告：attach 期間已實現損益
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
      const eq = accountMsg().equity_milli;
      eqStart = eq; eqHigh = eq; eqLow = eq;   // 離線報告：attach 起點
      lastSeenTick = null; lastSeenWall = null; // 新會話：重置離線起點
      let resolveReady;
      const ready = new Promise(r => { resolveReady = r; });
      const session = { cb, ready };
      // 下一個 microtask 送 snapshot（模擬 handshake）
      queueMicrotask(() => { cb(snapshotMsg()); resolveReady(); });
      return session;
    },
    handle,
    handleRest, // mock REST shim（contract REST 端點）
    detach(session) {
      clients.delete(session.cb);
      lastSeenTick = tick;                       // 離線期起點
      lastSeenWall = Date.now();
      if (!clients.size && timer) { clearInterval(timer); timer = null; }
    },
  };
}
