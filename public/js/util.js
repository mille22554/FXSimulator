/* util.js — DOM helpers + 顯示格式（規格 §7.6 E：顯示精確度定案） */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* ── 金額 ── */

/** 整數 A＋千分位（餘額、名目）。milli-A 輸入。 */
export function fmtA(milli) {
  if (milli == null || Number.isNaN(milli)) return '—';
  return Math.round(milli / 1000).toLocaleString('en-US');
}

/** 小數 1 位 A（浮動 P&L）。 */
export function fmtA1(milli) {
  if (milli == null || Number.isNaN(milli)) return '—';
  return (milli / 1000).toFixed(1);
}

/** K／M 縮寫（淨部位、大名目），輸入整數 A。 */
export function fmtCompactA(a) {
  const sign = a < 0 ? '−' : '+';
  const v = Math.abs(a);
  if (v >= 1e6) return `${sign}${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `${sign}${(v / 1e3).toFixed(1)}K`;
  return `${sign}${v.toLocaleString('en-US')}`;
}

/** 小數 2 位 A／時（持倉費）。輸入小數 A。 */
export function fmtFee(a) {
  if (a == null || Number.isNaN(a)) return '—';
  return a.toFixed(2);
}

/* ── 價格／百分比 ── */

/** 價格：小數 4 位（integer e4 輸入）。 */
export function fmtPrice(e4) {
  if (e4 == null || Number.isNaN(e4)) return '—';
  return (e4 / 10000).toFixed(4);
}

/** 百分比：小數 2 位。輸入 decimal fraction（0.008 = 0.80%）。 */
export function fmtPct(frac) {
  if (frac == null || Number.isNaN(frac)) return '—';
  return `${(frac * 100).toFixed(2)}%`;
}

export const pctSigned = f => (f >= 0 ? '+' : '−') + fmtPct(Math.abs(f));

export const priceE4 = v => Math.round(v * 10000);

/* ── 其他 ── */

export function fmtClock(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString('zh-TW', { hour12: false });
}

export function fmtHHMM(t) {
  const d = t instanceof Date ? t : new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
