/* rules.js — 條件單（conditional_open）：清單（生效／暫停／已觸發）、建立／編輯表單、
   啟用切換、刪除。REST：GET /api/rules?user=、PATCH /api/rules/:id；變動走 WS
   rule.upsert / rule.delete（回覆 rule.updated / rule.rejected）。
   觸發價與現價距離 <0.05% → 警示「會立刻成交；後端會以 trigger_too_close 拒絕。 */

import { state } from './state.js?v=12';
import { $, $$, el, fmtA, fmtPrice, priceE4, api } from './util.js?v=12';

const TRIGGER_TOO_CLOSE_PCT = 0.0005; // 0.05%

export const rulesStore = {
  max_active: 2,
  rules: [],            // Rule[]（contract 形狀）
  loaded: false,
};

let restApi = null;     // (path, method, body) → Promise(json)
let wsSend = null;      // (type, data, requestId) → void（app 提供 transport.send）
let editingId = null;   // null = 建立
let formLev = 10;
let formSide = 'long';

/* ── 顯示文字表 ── */
const STATUS_TEXT = {
  active: '生效中', paused: '暫停', triggered: '已觸發', cancelled: '已取消',
};
const REASON_TEXT = {
  max_active_rules: '生效中條件單已達 2 條上限',
  trigger_too_close: '觸發價距現價小於 0.05%，會立刻成交',
  invalid_trigger: '觸發價無效',
  invalid_margin: '保證金無效',
  invalid_leverage: '槓桿無效',
  invalid_side: '方向無效',
  insufficient_margin: '可用餘額不足',
  sl_invalid: '停損價無效',
  tp_invalid: '停利價無效',
  sl_wrong_side: '停損價方向錯誤（買入需低於現價、賣出需高於現價）',
  tp_wrong_side: '停利價方向錯誤（買入需高於現價、賣出需低於現價）',
  sl_too_close: '停損價太近（至少 0.05%）',
  sl_beyond_liq: '停損價超過強平距離',
  tp_too_close: '停利價太近（至少 0.05%）',
  sl_pct_removed: '此頁版本過舊，請重新整理（停損停利已改為價格）',
  tp_pct_removed: '此頁版本過舊，請重新整理（停損停利已改為價格）',
};
export const ruleReasonText = r => REASON_TEXT[r] || r;
const SKIPPED_TEXT = {
  insufficient_balance: '餘額不足', max_positions: '持倉已滿', debt_no_open: '負債無法開倉',
};
export const skippedReasonText = r => SKIPPED_TEXT[r] || r;

const activeCount = () => rulesStore.rules.filter(r => r.status === 'active').length;

/* ── API 層（mock 走 transport.rest；真實走 fetch） ── */
export function initRulesApi(transport) {
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

export function setRulesWsSender(fn) { wsSend = fn; }

/* GET /api/rules → { max_active, rules }；?user= 僅 dev_auth 模式帶 */
export async function loadRules() {
  if (!restApi) return;
  try {
    const qs = state.userId == null ? '' : `?user=${encodeURIComponent(state.userId)}`;
    const j = await restApi(`/api/rules${qs}`);
    if (j && Array.isArray(j.rules)) {
      rulesStore.max_active = j.max_active || 2;
      rulesStore.rules = j.rules;
      rulesStore.loaded = true;
      renderRules();
    }
  } catch { /* 面板開啟前失敗可忽略 */ }
}

/* WS rule.upsert / rule.delete（contract §WebSocket additions） */
function sendUpsert(data, requestId) {
  wsSend && wsSend('rule.upsert', { user: Number(state.userId) || state.userId, ...data }, requestId);
}
function sendDelete(ruleId, requestId) {
  wsSend && wsSend('rule.delete', { user: Number(state.userId) || state.userId, rule_id: ruleId }, requestId);
}

/* PATCH /api/rules/:id — 啟用／停用 */
async function patchEnabled(rule, enabled) {
  const j = await restApi(`/api/rules/${rule.id}`, 'PATCH', { user: Number(state.userId) || state.userId, enabled });
  if (j && j.rule) applyRuleUpdate(j.rule); // { ok, rule }
  renderRules();
  return j;
}

/* ── WS 訊息接應（由 app.js 呼叫） ── */
export function applyRuleUpdate(rule) {
  const i = rulesStore.rules.findIndex(r => r.id === rule.id);
  const isNew = i < 0;
  if (i >= 0) rulesStore.rules[i] = rule;
  else rulesStore.rules.push(rule);
  rulesStore.loaded = true;
  renderRules();
  // 建立成功：關閉表單並清掉「等待伺服器回覆」，避免玩家重複送出
  const form = $('#ruleForm');
  const note = $('#ruleFormNote');
  if (isNew && form && !form.hidden && note && note.textContent.startsWith('已送出')) {
    form.hidden = true;
    $('#ruleNewBtn').hidden = false;
    openFormNote('');
  }
}
export function applyRuleRejected(reason) {
  openFormNote(ruleReasonText(reason), true);
  renderRules();
}

/* ── 面板開關 ── */
export function toggleRulesPanel(open) {
  const p = $('#rulesPanel');
  if (!p) return;
  p.hidden = !open;
  if (open) {
    if (!rulesStore.loaded) loadRules();
    renderRules();
    $('#ruleForm').hidden = true;
    $('#ruleNewBtn').hidden = false;
  }
}

export function initRulesPanel() {
  $('#rulesBtn').addEventListener('click', () => toggleRulesPanel(true));
  $('#rulesClose').addEventListener('click', () => toggleRulesPanel(false));
  $('#ruleNewBtn').addEventListener('click', () => openForm(null));
  $('#ruleCancel').addEventListener('click', () => {
    $('#ruleForm').hidden = true;
    $('#ruleNewBtn').hidden = false;
  });

  $$('.rf-side-btn', $('#ruleForm')).forEach(b => {
    b.addEventListener('click', () => {
      formSide = b.dataset.side;
      $$('.rf-side-btn', $('#ruleForm')).forEach(x => {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-checked', String(on));
      });
      refreshFormCalc();
      refreshTriggerHint();
      refreshSltpHints();
    });
  });

  $('#ruleTrigger').addEventListener('input', refreshTriggerHint);
  $('#ruleMargin').addEventListener('input', refreshFormCalc);
  $('#ruleSl').addEventListener('input', refreshSltpHints);
  $('#ruleTp').addEventListener('input', refreshSltpHints);
  $('#ruleLevRow').addEventListener('click', e => {
    const btn = e.target.closest('.lev-btn');
    if (!btn) return;
    formLev = Number(btn.dataset.lev);
    $$('.lev-btn', $('#ruleLevRow')).forEach(b => b.setAttribute('aria-checked', String(b === btn)));
    refreshFormCalc();
  });

  $('#ruleForm').addEventListener('submit', e => { e.preventDefault(); submitRuleForm(); });

  // 清單動作（事件委派）
  $('#rulesList').addEventListener('change', e => {
    const sw = e.target.closest('[data-toggle]');
    if (!sw) return;
    const rule = rulesStore.rules.find(r => r.id === Number(sw.dataset.toggle));
    if (rule) patchEnabled(rule, sw.checked);
  });
  $('#rulesList').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) sendDelete(Number(del.dataset.del));
    const ed = e.target.closest('[data-edit]');
    if (ed) openForm(Number(ed.dataset.edit));
  });
}

/* ── 渲染 ── */
export function renderRules() {
  const n = activeCount();
  const limit = $('#rulesLimit');
  if (limit) {
    limit.textContent = `${n}/${rulesStore.max_active}`;
    limit.classList.toggle('full', n >= rulesStore.max_active);
  }
  const badge = $('#rulesCount');
  if (badge) {
    badge.textContent = `${n}/${rulesStore.max_active}`;
    badge.classList.toggle('full', n >= rulesStore.max_active);
  }

  if (!rulesStore.loaded || ( $('#rulesPanel') && $('#rulesPanel').hidden)) return;

  const list = $('#rulesList');
  list.textContent = '';
  $('#rulesEmpty').hidden = rulesStore.rules.length > 0;

  for (const r of rulesStore.rules) {
    const done = r.status === 'triggered' || r.status === 'cancelled';
    const li = el('li', `rule-item ${r.status === 'paused' ? 'is-paused' : done ? 'is-done' : ''}`);

    const row1 = el('div', 'rule-row1');
    row1.append(
      el('span', `rule-side ${r.side === 'long' ? 'up' : 'down'}`, r.side === 'long' ? '多' : '空'),
      el('b', 'rule-trigger mono', `觸發 ${fmtPrice(r.trigger_price_e4)}`),
      el('span', `rule-armed ${r.armed_side === 'above' ? 'up' : 'down'}`, r.armed_side === 'above' ? '↑高於現價' : '↓低於現價'),
      el('span', `rule-status st-${r.status}`, STATUS_TEXT[r.status] || r.status),
    );
    if (r.status === 'paused' && r.paused_reason === 'liquidation') {
      row1.append(el('span', 'rule-status st-lp', '強平暫停'));
    }

    const row2 = el('div', 'rule-row2');
    const bits = [
      `保證金 ${fmtA((r.margin_a ?? 0) * 1000)} 楓幣`,
      `${r.leverage}×`,
    ];
    if (r.sl_price_e4 != null) bits.push(`SL ${fmtPrice(r.sl_price_e4)}`);
    if (r.tp_price_e4 != null) bits.push(`TP ${fmtPrice(r.tp_price_e4)}`);
    for (const b of bits) row2.append(el('span', null, b));

    const row3 = el('div', 'rule-row3');
    if (r.last_error) {
      row3.append(el('span', 'rule-err', `${skippedReasonText(r.last_error)}，等待下次觸發`));
    }

    const acts = el('div', 'rule-acts');
    if (r.status !== 'triggered' && r.status !== 'cancelled') {
      const sw = el('label', 'rule-switch');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = r.status === 'active' && r.enabled !== false;
      cb.dataset.toggle = String(r.id);
      cb.setAttribute('aria-label', r.status === 'active' ? '停用條件單' : '重新啟用條件單');
      sw.append(cb, el('i', 'rule-knob'));
      acts.append(sw);
      const ed = el('button', 'rule-act-btn', '編輯');
      ed.type = 'button';
      ed.dataset.edit = String(r.id);
      acts.append(ed);
    }
    const del = el('button', 'rule-act-btn rule-del', '刪除');
    del.type = 'button';
    del.dataset.del = String(r.id);
    del.setAttribute('aria-label', `刪除條件單 ${r.id}`);
    acts.append(del);
    row3.append(acts);

    li.append(row1, row2, row3);
    list.appendChild(li);
  }
}

/* ── 表單 ── */
function openForm(id) {
  editingId = id;
  const f = $('#ruleForm');
  $('#ruleNewBtn').hidden = true;
  f.hidden = false;

  // 槓桿 chips（沿用下單面板樣式）
  const row = $('#ruleLevRow');
  row.textContent = '';
  const levs = (state.config && state.config.leverage) || [1, 2, 5, 10, 20, 50, 100];
  for (const l of levs) {
    const b = el('button', 'lev-btn', `${l}×`);
    b.type = 'button';
    b.dataset.lev = String(l);
    b.setAttribute('aria-checked', String(l === formLev));
    row.appendChild(b);
  }

  if (id) {
    const r = findRule(id);
    if (!r) { editingId = null; return openForm(null); }
    formSide = r.side;
    formLev = r.leverage;
    $$('.rf-side-btn', f).forEach(x => {
      const on = x.dataset.side === r.side;
      x.classList.toggle('active', on);
      x.setAttribute('aria-checked', String(on));
    });
    $('#ruleTrigger').value = (r.trigger_price_e4 / 10000).toFixed(4);
    $('#ruleMargin').value = String(r.margin_a);
    $('#ruleSl').value = r.sl_price_e4 != null ? (r.sl_price_e4 / 10000).toFixed(4) : '';
    $('#ruleTp').value = r.tp_price_e4 != null ? (r.tp_price_e4 / 10000).toFixed(4) : '';
    $('#ruleSubmit').textContent = '更新條件單';
    $$('.lev-btn', row).forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.lev) === r.leverage)));
  } else {
    formSide = 'long';
    formLev = 10;
    $$('.rf-side-btn', f).forEach(x => {
      const on = x.dataset.side === 'long';
      x.classList.toggle('active', on);
      x.setAttribute('aria-checked', String(on));
    });
    $('#ruleTrigger').value = '';
    $('#ruleMargin').value = '1000';
    $('#ruleSl').value = '';
    $('#ruleTp').value = '';
    $('#ruleSubmit').textContent = '建立條件單';
    $$('.lev-btn', row).forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.lev) === 10)));
  }
  openFormNote('');
  refreshFormCalc();
  refreshTriggerHint();
}

function findRule(id) { return rulesStore.rules.find(r => r.id === id); }

/* SL/TP 價格解析：空字串 → null；有值 → 整數 e4；無效 → NaN */
function parsePriceE4(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return NaN;
  return Math.round(v * 10000);
}

/* SL/TP 欄位即時提示：以觸發價為參考，顯示距離百分比或方向要求 */
function refreshSltpHints() {
  const trigE4 = priceE4(Number($('#ruleTrigger').value));
  const trigOk = trigE4 > 0;
  for (const [inpSel, hintSel, kind] of [['#ruleSl', '#ruleSlHint', 'sl'], ['#ruleTp', '#ruleTpHint', 'tp']]) {
    const hint = $(hintSel);
    if (!hint) continue;
    if (!trigOk) { hint.textContent = ''; continue; }
    // 做多：SL 需低於觸發價、TP 需高於觸發價；做空相反
    const needLower = kind === 'sl' ? formSide === 'long' : formSide === 'short';
    const sideText = `${formSide === 'long' ? '做多' : '做空'}需${needLower ? '低於' : '高於'}觸發價`;
    const raw = $(inpSel).value;
    const e4 = parsePriceE4(raw);
    if (raw.trim() === '' || Number.isNaN(e4)) { hint.textContent = sideText; continue; }
    const wrongSide = needLower ? e4 >= trigE4 : e4 <= trigE4;
    if (wrongSide) { hint.textContent = sideText; continue; }
    const gap = Math.abs(e4 - trigE4) / trigE4 * 100;
    hint.textContent = `距觸發 ${gap.toFixed(2)}%`;
  }
}

function refreshTriggerHint() {
  const p = state.market.price_e4;
  const pA = p != null ? p / 10000 : null;
  const v = Number($('#ruleTrigger').value);
  const hint = $('#ruleTriggerHint');
  const warn = $('#ruleTriggerWarn');
  if (!(v > 0) || pA == null) {
    hint.textContent = pA != null ? `現價 ${fmtPrice(p)}` : '';
    warn.hidden = true;
    return;
  }
  const gap = Math.abs(v - pA) / pA;
  hint.textContent = `現價 ${fmtPrice(p)} · 距觸發 ${(gap * 100).toFixed(3)}%`;
  // 方向 sanity：做多觸發價應低於現價（反之立刻成交）；或距離 <0.05%
  const dirOk = formSide === 'long' ? v < pA : v > pA;
  if (!dirOk) {
    warn.textContent = formSide === 'long' ? '觸發價高於現價，會立刻成交。' : '觸發價低於現價，會立刻成交。';
    warn.hidden = false;
  } else if (gap < TRIGGER_TOO_CLOSE_PCT) {
    warn.textContent = '距現價 <0.05%，會立刻成交。';
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
  refreshSltpHints();
}

function refreshFormCalc() {
  const m = Math.max(0, Math.round(Number($('#ruleMargin').value) || 0));
  $('#ruleNotional').textContent = `名目 ${(m * formLev).toLocaleString('en-US')} 楓幣`;
  const minMargin = state.config && state.config.min_margin_a ? state.config.min_margin_a[formLev] : 1000;
  const avail = Math.max(0, Math.floor((state.account.available_milli || 0) / 1000));
  $('#ruleMarginHint').textContent = `此槓桿最少 ${minMargin.toLocaleString('en-US')} 楓幣 · 可用 ${avail.toLocaleString('en-US')} 楓幣`;
}

function openFormNote(text, isErr) {
  const n = $('#ruleFormNote');
  n.hidden = !text;
  n.textContent = text || '';
  n.classList.toggle('is-err', !!isErr);
}

function submitRuleForm() {
  const triggerA = Number($('#ruleTrigger').value);
  if (!(triggerA > 0)) return openFormNote('請輸入觸發價', true);
  const margin_a = Math.round(Number($('#ruleMargin').value) || 0);
  if (!(margin_a > 0)) return openFormNote('請輸入保證金', true);
  const triggerE4 = priceE4(triggerA);

  // SL/TP 為絕對價格：空 → null；有值 → 整數 e4
  const slE4 = parsePriceE4($('#ruleSl').value);
  const tpE4 = parsePriceE4($('#ruleTp').value);
  if (Number.isNaN(slE4) || Number.isNaN(tpE4)) return openFormNote('停損／停利價格式無效，請輸入有效價格。', true);

  // 方向 sanity（以觸發價為參考；後端仍會擋）
  const sideText = formSide === 'long' ? '做多' : '做空';
  if (slE4 != null) {
    const bad = formSide === 'long' ? slE4 >= triggerE4 : slE4 <= triggerE4;
    if (bad) return openFormNote(`${sideText}的停損價需${formSide === 'long' ? '低於' : '高於'}觸發價。`, true);
    if (Math.abs(slE4 - triggerE4) / triggerE4 < TRIGGER_TOO_CLOSE_PCT) return openFormNote('停損價太近（至少 0.05%）。', true);
  }
  if (tpE4 != null) {
    const bad = formSide === 'long' ? tpE4 <= triggerE4 : tpE4 >= triggerE4;
    if (bad) return openFormNote(`${sideText}的停利價需${formSide === 'long' ? '高於' : '低於'}觸發價。`, true);
    if (Math.abs(tpE4 - triggerE4) / triggerE4 < TRIGGER_TOO_CLOSE_PCT) return openFormNote('停利價太近（至少 0.05%）。', true);
  }

  const data = {
    side: formSide,
    trigger_price_e4: triggerE4,
    margin_a,
    leverage: formLev,
    sl_price_e4: slE4,
    tp_price_e4: tpE4,
  };

  const rid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (editingId) sendDelete(editingId, `rdel${rid}`); // M3 contract 無編輯端點 → 取消＋重建
  sendUpsert(data, `rup${rid}`);
  openFormNote('已送出，等待伺服器回覆…');
}

/* 每 tick 由 app 呼叫：面板開啟時刷新觸發價提示（現價會動） */
export function rulesOnTick() {
  if ($('#rulesPanel') && !$('#rulesPanel').hidden && !$('#ruleForm').hidden) {
    refreshTriggerHint();
  }
}
