/* order.js — 下單面板：槓桿 toggle、保證金輸入＋拉桿雙向同步、
   即時預覽（名目／預估成交／強平／持倉費／最大損失）、
   SL/TP（上限＝強平距離×0.9）、自動再下單計數、300ms debounce 送出。 */

import { state } from './state.js';
import { $, $$, el, fmtA, fmtFee, fmtPrice, fmtPct, pctSigned, priceE4 } from './util.js';

const cfg = () => state.config;

let lev = 10;
let sendFn = null;          // (type, data) → void（app 提供 transport.send）
let debounceTimer = null;
let lastSend = 0;

export function initOrderPanel(onSend) {
  sendFn = onSend;

  // 槓桿 chips
  const row = $('#levRow');
  row.textContent = '';
  for (const l of cfg().leverage) {
    const b = el('button', 'lev-btn', `${l}×`);
    b.type = 'button';
    b.role = 'radio';
    b.dataset.lev = String(l);
    b.setAttribute('aria-checked', String(l === lev));
    row.appendChild(b);
  }
  row.addEventListener('click', e => {
    const btn = e.target.closest('.lev-btn');
    if (!btn) return;
    lev = Number(btn.dataset.lev);
    $$('.lev-btn', row).forEach(b => b.setAttribute('aria-checked', String(b === btn)));
    clampMargin();
    renderPreview();
  });

  // 保證金輸入 ↔ 拉桿
  const input = $('#marginInput');
  const slider = $('#marginSlider');
  input.addEventListener('change', () => { input.value = String(normalizeMargin(Number(input.value))); renderPreview(); });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    if (!Number.isNaN(v) && v > 0) { slider.value = String(clampToSlider(v)); }
    renderPreview();
  });
  slider.addEventListener('input', () => {
    input.value = slider.value;
    renderPreview();
  });

  // SL / TP
  $('#slInput').addEventListener('input', renderPreview);
  $('#tpInput').addEventListener('input', renderPreview);

  // 自動再下單
  $('#reentryCheck').addEventListener('change', e => {
    state.reentry.enabled = e.target.checked;
    if (!e.target.checked) state.reentry.count = 0;
    renderReentry();
  });

  // 買入／賣出
  $('#btnBuy').addEventListener('click', () => submit('long'));
  $('#btnSell').addEventListener('click', () => submit('short'));

  renderPreview();
}

export function currentLev() { return lev; }
export function currentMarginA() { return Math.max(0, Math.round(Number($('#marginInput').value) || 0)); }
export function consumeReentry() { state.reentry.count = Math.min(3, state.reentry.count + 1); renderReentry(); }
export function renderReentry() {
  const c = $('#reentryCount');
  c.textContent = `${state.reentry.count}/3`;
  c.classList.toggle('up', state.reentry.count > 0);
  if (state.reentry.count >= 3) $('#reentryCheck').checked = false;
}

/* ── 保證金夾取 ── */
export function marginBounds() {
  const minMargin = cfg().min_margin_a[lev] || 1000;           // A（contract min_margin_a）
  const availableA = Math.max(0, Math.floor((state.account.available_milli || 0) / 1000));
  return { minMargin, availableA };
}

function clampToSlider(v) { return Math.round(v / 10) * 10; }

function normalizeMargin(v) {
  const { minMargin, availableA } = marginBounds();
  if (availableA <= 0) return 0;
  let m = Math.round(v / 10) * 10;
  const effMin = Math.min(minMargin, availableA);
  if (m < effMin) m = effMin;
  if (m > availableA) m = Math.floor(availableA / 10) * 10;
  return Math.max(0, m);
}

export function clampMargin() {
  const input = $('#marginInput');
  const slider = $('#marginSlider');
  const { minMargin, availableA } = marginBounds();
  const cur = currentMarginA();

  // 名目上限 min(2L, available×lev) → 換算成保證金上限（規格 §7.5）
  const lA = state.market.L_milli != null ? state.market.L_milli / 1000 : Infinity;
  const maxMarginA = Math.floor(Math.min(availableA, 2 * lA / lev) / 10) * 10;

  // 切換槓桿自動夾住：小於最小 → 上調；大於可用 → 下調
  let m = Math.round(cur / 10) * 10;
  const effMin = Math.min(minMargin, maxMarginA);
  if (m < effMin && maxMarginA >= effMin) m = effMin;
  if (m > maxMarginA) m = maxMarginA;
  m = Math.max(0, m);

  input.value = String(m);
  slider.min = String(effMin);
  slider.max = String(Math.max(maxMarginA, 0));
  if ( Number(slider.max) < Number(slider.min)) slider.disabled = true; else { slider.disabled = false; slider.value = String(clampToSlider(m) || slider.min); }

  // 可用不足／名目上限
  const note = $('#marginNote');
  const disabled = availableA < minMargin || availableA <= 0 || maxMarginA < minMargin;
  if (disabled) {
    note.hidden = false;
    note.textContent = maxMarginA < minMargin
      ? '名目上限不足，無法以此槓桿開單。'
      : availableA < minMargin
        ? `此槓桿最少需 ${minMargin.toLocaleString('en-US')} A`
        : '可用保證金不足，無法開新倉。';
  } else note.hidden = true;
  $('#btnBuy').disabled = disabled;
  $('#btnSell').disabled = disabled;
}

/* ── 預覽計算（所有數字由 contract 欄位與 config 推導，顯示層只做這些展示換算） ── */
export function computePreview(marginA, side) {
  const c = cfg();
  const priceE4v = state.market.price_e4;
  if (!priceE4v || marginA <= 0) return null;
  const price = priceE4v / 10000;
  const spread = c.spread_per_side ?? 0.0002;
  const notionalA = marginA * lev;
  const fill = price * (1 + (side === 'long' ? spread : -spread));
  const liqDist = 1 / lev - (c.maintenance_rate ?? 0.002);   // 1/L − 0.2%（D35）
  const liqMarker = side === 'long' ? -1 : 1;
  const liq = fill * (1 + liqMarker * liqDist);
  const feeAnnual = side === 'long' ? c.fee_long_annual : c.fee_short_annual;
  const feePerHour = notionalA * feeAnnual / 365 / 24;
  return { notionalA, fill, liq, liqDist, feePerHour, _fillE4: priceE4(fill), _liqE4: priceE4(liq), _marker: liqMarker };
}

export function renderPreview() {
  const marginA = currentMarginA();
  const pBuy = computePreview(marginA, 'long');
  const pSell = computePreview(marginA, 'short');

  if (!pBuy) {
    ['#pvNotional', '#pvFillBuy', '#pvFillSell', '#pvLiq', '#pvFeeBuy', '#pvFeeSell', '#pvMargin'].forEach(s => { $(s).textContent = '—'; });
    $('#bigOrderWarn').hidden = true;
    return;
  }

  $('#pvNotional').textContent = `${fmtA(marginA * lev * 1000)} A`;

  $('#pvFillBuy').textContent = fmtPrice(priceE4(pBuy.fill));
  $('#pvFillSell').textContent = fmtPrice(priceE4(pSell.fill));

  // 強平展示以買入方向為基準（賣出對稱＋）
  $('#pvLiq').textContent = fmtPrice(pBuy._liqE4);
  $('#pvLiqDist').textContent = `（${pctSigned(-pBuy.liqDist)}）`;

  $('#pvFeeBuy').textContent = fmtFee(pBuy.feePerHour);
  $('#pvFeeSell').textContent = fmtFee(pSell.feePerHour);

  $('#pvMargin').textContent = `${fmtA(marginA * 1000)} A`;

  // SL/TP 上限：強平距離 × 0.9；欄位單位＝% 數字（0.5 = 0.5%，contract 定案）
  const maxPctInput = pBuy.liqDist * 100 * 0.9;
  for (const [inpId, noteKey] of [['#slInput', 'sl'], ['#tpInput', 'tp']]) {
    const inp = $(inpId);
    let v = Number(inp.value);
    if (inp.value === '' || Number.isNaN(v) || v <= 0) continue;
    let clamped = false;
    if (v > maxPctInput) { v = Math.floor(maxPctInput * 100) / 100; inp.value = String(v); clamped = true; }
    const dir = noteKey === 'sl' ? -1 : 1;
    const price = pBuy.fill * (1 + dir * v / 100);
    $(noteKey === 'sl' ? '#slPrice' : '#tpPrice').textContent = `≈ ${fmtPrice(priceE4(price))}`;
    const note = $('#sltpNote');
    note.hidden = !clamped;
    if (clamped) note.textContent = '超過強平線，已自動夾在強平距離 90%。';
  }
  const slEmpty = $('#slInput').value === '';
  const tpEmpty = $('#tpInput').value === '';
  if (slEmpty) $('#slPrice').textContent = '';
  if (tpEmpty) $('#tpPrice').textContent = '';

  // 大單警示（> 可用 50%）
  const { availableA } = marginBounds();
  const big = availableA > 0 && marginA > availableA * 0.5;
  $('#bigOrderWarn').hidden = !big;
  if (big) {
    $('#bigOrderLoss').textContent = fmtA(marginA * 1000);
    $('#btnBuy').classList.add('big-order');
    $('#btnSell').classList.add('big-order');
  } else {
    $('#btnBuy').classList.remove('big-order');
    $('#btnSell').classList.remove('big-order');
  }

  // 面板內即時顯示可用（規格 §7.2 佈局：可用 X A）
  $('#marginHint').textContent = `可用 ${fmtA(availableA * 1000)} A`;
}

/* ── 送出：不做二次確認；按鈕 300ms debounce ── */
function submit(side) {
  const now = Date.now();
  if (now - lastSend < 300) return; // debounce（防連點）
  lastSend = now;
  const marginA = currentMarginA();
  const { minMargin, availableA } = marginBounds();
  if (marginA <= 0 || availableA < minMargin) return;

  const slRaw = Number($('#slInput').value);
  const tpRaw = Number($('#tpInput').value);
  const p = computePreview(marginA, side);
  const data = {
    side,
    margin_a: marginA,
    leverage: lev,
    sl_pct: slRaw > 0 ? Number(slRaw.toFixed(4)) : null,
    tp_pct: tpRaw > 0 ? Number(tpRaw.toFixed(4)) : null,
  };
  if (state.reentry.enabled) consumeReentry();
  sendFn('order.open', data);

  // 300ms 鎖定視覺
  for (const id of ['#btnBuy', '#btnSell']) {
    const b = $(id);
    b.classList.add('cooldown');
    setTimeout(() => b.classList.remove('cooldown'), 350);
  }
}

/** 每次 tick 呼叫：可用變動 → 重夾＋重繪（不覆寫使用者草稿除非越界） */
export function refreshOnTick() {
  clampMargin();
  renderPreview();
}
