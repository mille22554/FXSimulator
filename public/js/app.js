/* app.js — 進入點：登入閘門（/api/me；M3）→ 讀 config → 連線（?mock=1 或 /ws）→
   snapshot 接管狀態 → tick 1Hz 重繪、下單送出（WS order.open／order.close）→
   toast／橫幅／連線狀態。未登入一律不初始化交易 WS。 */

import { state, applySnapshot, applyTick, applyEventMessage, maybeCloseMinute, advanceForming } from './state.js';
import { createTransport } from './ws.js';
import { initAuthApp, isDevAuth, fetchMe, showLogin, currentUser } from './auth.js';
import { Chart } from './chart.js';
import { initOrderPanel, refreshOnTick } from './order.js';
import { initPositions, renderPositions } from './positions.js';
import { initNews, renderNews, maybeBanner } from './news.js?v=3';
import { initRulesPanel, initRulesApi, setRulesWsSender, loadRules, renderRules, applyRuleUpdate, applyRuleRejected, ruleReasonText, rulesOnTick } from './rules.js';
import { initReport, initReportApi, fetchAndShowReport } from './report.js';
import { $, fmtA, fmtA1, fmtCompactA, fmtPrice, fmtClock, uuid, pctSigned, api } from './util.js';

const params = new URLSearchParams(location.search);
state.isMock = params.get('mock') === '1';
const wantUserParam = params.get('user'); // M3：等 /api/me 確認 dev_auth 後才套用

const MOCK_CONFIG = {
  leverage: [1, 2, 5, 10, 20, 50, 100],
  default_leverage: 10,
  min_margin_a: { 1: 10000, 2: 5000, 5: 2000, 10: 1000, 20: 500, 50: 200, 100: 100 },
  max_positions: 5,
  min_notional_a: 10000,
  spread_per_side: 0.0002,
  fee_long_annual: 0.026,
  fee_short_annual: 0.009,
  maintenance_rate: 0.002,
};

/* ── Toast ── */
const REJECT_TEXT = {
  insufficient_balance: '餘額不足',
  max_positions: '持倉已滿 5 張',
  min_notional: '低於最小名目 10,000 A',
  max_notional: '超過名目上限',
  debt_no_open: '負債狀態無法開單',
  invalid_leverage: '無效槓桿',
  invalid_side: '無效方向',
  not_found: '找不到該持倉（可能已平倉）',
  market_paused: '市場暫停',
};

function toast(kind, text) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.append(
    Object.assign(document.createElement('span'), { className: 't-ico', textContent: kind === 'ok' ? '✓' : kind === 'liq' ? '⚡' : '✕' }),
    Object.assign(document.createElement('span'), { textContent: text }),
  );
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 4200);
}

/* ── 圖表 ── */
let chart;

/* ── 連線狀態 ── */
function setConn(status, attempt, wait) {
  const badge = $('#connBadge');
  const text = $('#connText');
  badge.classList.remove('conn-online', 'conn-reconnect', 'conn-offline', 'conn-connecting', 'conn-mock');
  if (state.isMock) {
    badge.classList.add('conn-mock');
    text.textContent = '模擬模式';
    return;
  }
  switch (status) {
    case 'online': badge.classList.add('conn-online'); text.textContent = '已連線'; break;
    case 'reconnect':
      badge.classList.add('conn-reconnect');
      text.textContent = `重連中（第 ${attempt || 1} 次，${Math.round((wait || 1000) / 1000)}s）`;
      break;
    case 'offline': badge.classList.add('conn-offline'); text.textContent = '離線'; break;
    case 'unauthorized': badge.classList.add('conn-offline'); text.textContent = '未授權'; break;
    default: badge.classList.add('conn-connecting'); text.textContent = '連線中…';
  }
}

/* ── 頂部列 ── */
function renderTopbar() {
  const a = state.account;
  $('#statBalance').textContent = fmtA(a.balance_milli);
  $('#statAvailable').textContent = fmtA(a.available_milli);
  $('#statEquity').textContent = fmtA(a.equity_milli);
  $('#statMargin').textContent = fmtA(a.margin_milli);

  const diff = (a.equity_milli || 0) - (a.balance_milli || 0);
  const arrow = $('#equityArrow');
  arrow.textContent = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
  arrow.className = `dir-arrow mono ${diff > 0 ? 'up' : diff < 0 ? 'down' : 'dim'}`;

  const n = state.market.net_notional_milli;
  const nn = $('#statNetPos');
  nn.textContent = fmtCompactA(Math.round(n / 1000));
  nn.className = `mono ${n > 0 ? 'up' : n < 0 ? 'down' : 'dim'}`;

  // 報價
  const p = state.market.price_e4;
  const priceEl = $('#tickPrice');
  if (p != null) {
    priceEl.textContent = fmtPrice(p);
    priceEl.className = `mono ${state.priceDir > 0 ? 'up' : state.priceDir < 0 ? 'down' : ''}`;
  }
  const base = state.market.base_price_e4;
  if (p != null && base) {
    const dd = $('#tickDelta');
    dd.textContent = pctSigned((p - base) / base);
    dd.className = `mono ${p >= base ? 'up' : 'down'}`;
  }
  $('#serverClock').textContent = fmtClock(new Date(state.serverNow).toISOString());

  // 圖表標題
  const cp = $('#chartPrice');
  if (p != null) {
    const prev = Number(cp.dataset.v || p);
    cp.textContent = fmtPrice(p);
    cp.classList.remove('tick-up', 'tick-down');
    if (prev && p > prev) cp.classList.add('tick-up');
    else if (prev && p < prev) cp.classList.add('tick-down');
    cp.dataset.v = String(p);
  }
  // 相對 base 變化
  if (base) {
    const chg = $('#chartChange');
    chg.textContent = pctSigned((p - base) / base);
    chg.className = `mono chg ${p >= base ? 'up' : 'down'}`;
  }
  // 今日高低（60 分窗）
  if (state.candles.length) {
    let hi = -Infinity, lo = Infinity;
    for (const c of state.candles) { hi = Math.max(hi, c.high_e4); lo = Math.min(lo, c.low_e4); }
    $('#chartRange').textContent = `高 ${fmtPrice(hi)} 低 ${fmtPrice(lo)}`;
  }
}

function renderAll() {
  renderTopbar();
  renderPositions();
  renderNews();
  refreshOnTick();
  rulesOnTick();
  chart.render();
}

/* ── 送單 ── */
function onSend(type, data) {
  const request_id = uuid();
  state.pendingOrders.set(request_id, { type, ...data });
  if (transport) transport.send({ type, request_id, data });
}

function onClosePosition(id) {
  if (!transport) return;
  transport.send({ type: 'order.close', request_id: uuid(), data: { position_id: id } });
}

/* ── WS 訊息 ── */
let transport = null;
let wasReconnect = false;

function handleMessage(m) {
  switch (m.type) {
    case 'snapshot': {
      const fresh = !state.connectedOnce;
      applySnapshot(m.data, { replaceCandles: wasReconnect });
      wasReconnect = false;
      renderAll();
      if (fresh) {
        // 初次載入另取完整 candles／events（contract REST）
        loadRestBootstrap(m.data);
        // M3：條件單清單＋離線報告（mock 走 transport.rest shim；真實走 fetch）
        loadRules();
        fetchAndShowReport();
      }
      break;
    }
    case 'tick':
      advanceTickWallclock(m.data);
      applyTick(m.data);
      maybeCloseMinute();
      scheduleRender();
      break;
    case 'order.filled': {
      state.pendingOrders.delete(m.request_id);
      const d = m.data;
      const fill = d.fill || {};
      // contract：order.close 的回覆帶 exit_price_e4 / pnl_milli
      if (d.exit_price_e4 != null) {
        const pnl = d.pnl_milli;
        toast('ok', `平倉成交 @ ${fmtPrice(d.exit_price_e4)}，損益 ${pnl > 0 ? '+' : ''}${fmtA1(pnl)} A`);
      } else {
        const side = d.side === 'long' ? '買入' : '賣出';
        // contract：超過名目上限可能 ok:true + fill.truncated:true（已截斷）
        const trunc = fill.truncated || d.truncated ? '，已依名目上限截斷' : '';
        toast('ok', `${side}成交 ${fmtA(fill.notional_milli ?? 0)} A @ ${fmtPrice(fill.price_e4)}${trunc}`);
      }
      renderAll();
      break;
    }
    case 'order.rejected': {
      state.pendingOrders.delete(m.request_id);
      toast('err', `被拒絕：${REJECT_TEXT[m.data.reason] || m.data.reason}`);
      break;
    }
    case 'liquidation': {
      const d = m.data;
      toast('liq', `強平：持倉 #${d.position_id} 於 ${fmtPrice(d.price_e4)} 觸發，損失 ${fmtA1(d.pnl_milli)} A`);
      renderAll();
      break;
    }
    case 'event': {
      const isNew = state.events.length === 0 || state.events[0].id !== m.data.id;
      applyEventMessage(m.data);
      if (isNew) {
        renderNews();
        maybeBanner(m.data);
        chart.render();
      }
      break;
    }
    /* ── M3：條件單訊息 ── */
    case 'rule.updated': {
      applyRuleUpdate(m.data);
      if (m.request_id) state.pendingOrders.delete(m.request_id);
      if (m.data && m.data.status === 'cancelled') toast('ok', `條件單 #${m.data.id} 已取消`);
      break;
    }
    case 'rule.triggered': {
      const d = m.data;
      const filled = d.fill_price_e4 != null ? fmtPrice(d.fill_price_e4) : '—';
      toast('ok', `條件單 #${d.rule_id} ${d.side === 'long' ? '買入' : '賣出'}成交 @ ${filled}`);
      renderAll();
      break;
    }
    case 'rule.skipped': {
      const d = m.data;
      const txt = { insufficient_balance: '餘額不足', max_positions: '持倉已滿', debt_no_open: '負債無法開倉' }[d.reason] || d.reason;
      toast('err', `條件單 #${d.rule_id} 未能成交：${txt}（規則維持生效）`);
      break;
    }
    case 'rule.rejected': {
      const rreason = m.data && m.data.reason;
      applyRuleRejected(rreason);
      toast('err', `條件單被拒：${ruleReasonText(rreason)}`);
      break;
    }
    default: break;
  }
}

/* 進場後每次 tick 之前先對齊牆鐘（tick 只 1s 一發，秒間用本地鐘） */
function advanceTickWallclock() { /* state.serverNow 已於 applyTick 更新 */ }

/* contract 定案備忘：POST 業務拒絕回 HTTP 200 + {ok:false, reason}（一律檢查 ok）；
   本頁下單走 WS（order.rejected 對應 reason 同組），REST /api/open、/api/close 留給
   CLI／測試使用，故前端不呼叫；若 M3 改走 REST，記得沿用 ok 檢查。 */

/* 初載 REST 補強：candles 與 events 以 REST 為準（contract 允許空陣列） */
async function loadRestBootstrap(snapData) {
  try {
    if (!snapData.candles || snapData.candles.length < 60) {
      const r = await fetch(api('/api/candles?limit=60'));
      if (r.ok) {
        const arr = await r.json();
        state.candles = arr.slice(-600);
        state.forming = null;
        advanceForming();
      }
    }
    if (!snapData.events || !snapData.events.length) {
      const r = await fetch(api('/api/events?limit=100'));
      if (r.ok) {
        const arr = await r.json();
        state.events = arr.slice(0, 100);
      }
    }
    renderAll();
  } catch { /* mock 或 REST 不可用 → 忽略 */ }
}

/* ── 遊戲鐘：每 250ms 同步秒間的 server_now（推進 forming K 與時鐘） ── */
setInterval(() => {
  if (state.connectedOnce) {
    const drift = Date.now() + state.clockSkew;
    if (document.visibilityState === 'visible') {
      const before = state.serverNow;
      state.serverNow = drift;
      if (Math.floor(before / 60000) !== Math.floor(drift / 60000)) {
        maybeCloseMinute();
        scheduleRender();
      }
    }
  }
  $('#serverClock').textContent = state.connectedOnce
    ? fmtClock(new Date(state.serverNow).toISOString())
    : $('#serverClock').textContent;
}, 1000);

/* ── rAF 渲染排程：tick 驅動（1Hz）＋互動直接叫 ── */
let rafQueued = false;
function scheduleRender() {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    renderAll();
  });
}

/* ── 圖表模式 tabs ── */
function initModeTabs() {
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.ui.chartMode = tab.dataset.mode;
      document.querySelectorAll('.mode-tab').forEach(t => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      });
      chart.render();
    });
  });
}

/* ── M3：/api/me 確認 dev_auth 後才允許 ?user=；其他一律純 session ── */
function applyUserId() {
  state.devAuth = isDevAuth();
  state.userId = state.devAuth ? (wantUserParam || '1') : null;
}

/* ── M3：WS handshake 因未授權被關（1008）──
   先向 /api/me 覆核：session 仍有效時不誤登出（例如 ?user= 被伺服器拒絕）；
   session 真的失效 → 清使用者、停止重連、顯示登入遮罩。 */
let wsAuthHandled = false;
async function handleWsUnauthorized() {
  if (wsAuthHandled) return;
  wsAuthHandled = true;
  try { transport && transport.close(); } catch { /* noop */ }
  setConn('unauthorized');
  const me = await fetchMe();
  if (me.ok && me.user) { // session 仍有效，僅交易連線被拒（如 ?user= 未核可）
    toast('err', '交易連線被伺服器拒絕，請確認帳號權限後重新整理頁面。');
    state.devAuth = false;
    state.userId = null;
    return;
  }
  state.pendingOrders.clear();
  state.devAuth = false;
  state.user = null;
  showLogin('登入狀態已失效，請重新登入。');
}

/* ── boot ── */
async function boot() {
  /* ── 登入閘門：先確認使用者，未登入就停在遮罩、不初始化交易 WS ── */
  const authOk = await initAuthApp(state.isMock, wantUserParam);
  if (!authOk) return;
  applyUserId();
  state.user = currentUser(); // 顯示由 auth.js（topAuth）管理，state.user 備查
  wsAuthHandled = false;

  initModeTabs();

  // config：mock 用常數；真實取 /api/config
  if (state.isMock) {
    state.config = MOCK_CONFIG;
  } else {
    try {
      const r = await fetch(api('/api/config'));
      state.config = r.ok ? await r.json() : MOCK_CONFIG;
    } catch { state.config = MOCK_CONFIG; }
  }

  chart = new Chart($('#chartMain'), $('#chartSub'), $('#chartTip'));
  initOrderPanel(onSend);
  initPositions(onClosePosition);
  initNews(() => chart.render());
  // M3：條件單 + 離線報告
  initRulesPanel();
  initReport();

  setConn('connecting');

  transport = createTransport({
    mock: state.isMock,
    userId: state.userId,
    mockOpts: { forceReport: params.get('report') === 'liq' ? 'liq' : params.get('report') === '1' ? 'report' : null },
    onUnauthorized: handleWsUnauthorized,
    onStatus: (s, n, w) => {
      // 重連成功 → 下一個 snapshot 以 REST 資料覆蓋重建（規格 §7.6 斷線重連）
      if (s === 'online' && state.connectedOnce) wasReconnect = true;
      setConn(s, n, w);
    },
    onMessage: handleMessage,
  });

  // M3：API 層先掛 transport（mock 用 rest shim；真實用 fetch），connect 期間 snapshot 就能取規則
  initRulesApi(transport);
  initReportApi(transport);
  setRulesWsSender((type, data, request_id) => {
    state.pendingOrders.set(request_id, { type, ruleReq: true });
    transport.send({ type, request_id, data });
  });

  await transport.connect();

  renderAll();
}

boot();
