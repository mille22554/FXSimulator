/* report.js — 離線報告：GET /api/report?user=（伺服器以 last_seen_tick 計算離線期間）、
   顯示離線時長／收益／淨值起迄高低／觸發紀錄（open/sl/tp/skipped/liquidation）、
   liquidated 紅色警示。關閉時可選 POST /api/report/ack（contract 標 optional）。 */

import { state } from './state.js';
import { $, el, fmtA, fmtA1, fmtPrice, api } from './util.js';

let restApi = null;

export function initReportApi(transport) {
  restApi = transport && transport.kind === 'mock' && transport.rest
    ? transport.rest
    : httpRest;
}

async function httpRest(path, method = 'GET', body = null) {
  const r = await fetch(api(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({}));
}

const KIND_TEXT = { open: '開倉', sl: '停損', tp: '停利', liquidation: '強平', skipped: '跳過' };
const SKIPPED_TEXT = {
  insufficient_balance: '餘額不足', max_positions: '持倉已滿', debt_no_open: '負債無法開倉',
};

export function initReport() {
  $('#reportClose').addEventListener('click', () => {
    $('#reportModal').hidden = true;
    ackReport();
  });
}

/* 連線後呼叫：report 存在且真的有離線期間才彈出 */
export async function fetchAndShowReport() {
  if (!restApi) return;
  try {
    const j = await restApi(`/api/report${state.userId == null ? '' : `?user=${encodeURIComponent(state.userId)}`}`);
    if (!j || j.until_tick == null || j.since_tick == null) return;
    if (j.since_tick <= 0) return; // 新帳號第一次上線：不顯示離線報告
    // 無離線期間 → 不彈；明顯短暫的重連（<60s 且無事件）→ 不打擾
    const hasEvents = (j.triggers || []).length > 0 || !!j.liquidated;
    if (j.until_tick - j.since_tick < 1) return;
    if ((j.offline_seconds ?? 0) < 60 && !hasEvents) return;
    renderReport(j);
  } catch { /* report 不可用 → 靜默 */ }
}

function renderReport(r) {
  $('#rpDuration').textContent = fmtDuration(r.offline_seconds || 0);

  const inc = $('#rpIncome');
  const incMilli = r.income_milli ?? 0;
  inc.textContent = `${incMilli > 0 ? '+' : ''}${fmtA1(incMilli)} A`;
  inc.className = `mono ${incMilli > 0 ? 'up' : incMilli < 0 ? 'down' : 'dim'}`;

  $('#rpEqStart').textContent = fmtA(r.equity_start_milli);
  $('#rpEqEnd').textContent = fmtA(r.equity_end_milli);
  $('#rpEqHigh').textContent = fmtA(r.equity_high_milli);
  $('#rpEqLow').textContent = fmtA(r.equity_low_milli);

  const eqDelta = (r.equity_end_milli ?? 0) - (r.equity_start_milli ?? 0);
  const endEl = $('#rpEqEnd');
  endEl.className = `mono ${eqDelta > 0 ? 'up' : eqDelta < 0 ? 'down' : ''}`;

  $('#rpLiqRow').hidden = !r.liquidated;

  const list = $('#rpTriggers');
  list.textContent = '';
  const trig = r.triggers || [];
  $('#rpEmpty').hidden = trig.length > 0;
  for (const t of trig) {
    const li = el('li', `rp-item ${t.kind === 'liquidation' ? 'is-liq' : ''}`);
    const k = el('span', `rp-kind k-${t.kind}`, KIND_TEXT[t.kind] || t.kind);
    const mid = el('span', 'rp-mid');
    const sideTxt = t.side ? (t.side === 'long' ? '多' : '空') : '';
    if (t.kind === 'skipped') {
      mid.append(el('span', null, `條件單 #${t.rule_id} ${SKIPPED_TEXT[t.reason] || t.reason || ''}`));
    } else {
      mid.append(
        el('b', null, `#${t.rule_id} ${sideTxt}`),
        el('span', 'mono dim', ` @ ${fmtPrice(t.price_e4)}`),
      );
      if (t.pnl_milli != null) {
        const pnl = el('b', `rp-pnl mono ${t.pnl_milli > 0 ? 'up' : t.pnl_milli < 0 ? 'down' : 'dim'}`,
          `${t.pnl_milli > 0 ? '+' : ''}${fmtA1(t.pnl_milli)} A`);
        mid.append(pnl);
      }
    }
    li.append(k, mid);
    list.appendChild(li);
  }

  $('#reportModal').hidden = false;
}

/* contract：report 供出後 client 可選 POST /api/report/ack 移動 last_seen_tick */
async function ackReport() {
  try { await restApi(`/api/report/ack`, 'POST', { user: Number(state.userId) || state.userId }); } catch { /* optional */ }
}

function fmtDuration(sec) {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
  }
  if (sec >= 60) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${sec} 秒`;
}
