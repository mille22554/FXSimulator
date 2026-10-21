/**
 * 金額 / 價格換算與四捨五入工具。
 *
 *  - 金額一律用整數 milli-A（1 A = 1,000）
 *  - 價格一律用整數 e4（5.0000 = 50,000）
 *  - 交易損益（P&L）四捨五入到 milli-A
 *  - 持倉費用 floor + 餘數累積（remainder carry）
 */

import { MILLI_PER_A, E4 } from './config.js';

/** A → milli-A（整數） */
export function aToMilli(a) {
  return Math.round(a * MILLI_PER_A);
}

/** milli-A → A（float，僅顯示用） */
export function milliToA(milli) {
  return milli / MILLI_PER_A;
}

/** float 價格 → e4 整數 */
export function priceToE4(price) {
  return Math.round(price * E4);
}

/** e4 整數 → float 價格 */
export function e4ToPrice(e4) {
  return e4 / E4;
}

/**
 * 四捨五入（half-up，朝 +∞）：0.5 → 1、-0.5 → 0。
 * P&L 結算固定用這個規則，確保重複結算不會累積誤差。
 */
export function roundHalfUp(x) {
  return Math.floor(x + 0.5);
}

/**
 * 持倉費結算：floor(精確值 + 上次餘數)，並回傳新餘數。
 * @param {number} exact      精確費用（milli-A，可有小數）
 * @param {number} remainder  上期累積餘數（milli-A）
 */
export function floorWithRemainder(exact, remainder = 0) {
  const total = exact + remainder;
  const charge = Math.floor(total);
  return { charge, remainder: total - charge };
}

/** 顯示用：milli-A → "1,234.567 A" */
export function formatMilli(milli) {
  const a = milli / MILLI_PER_A;
  const sign = a < 0 ? '-' : '';
  const abs = Math.abs(a);
  const [int, frac = '0'] = abs.toFixed(3).split('.');
  return `${sign}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac} A`;
}

/** 顯示用：e4 → "5.0000" */
export function formatE4(e4) {
  return (e4 / E4).toFixed(4);
}

/** 顯示用：百分比 */
export function formatPct(x, digits = 2) {
  return `${(x * 100).toFixed(digits)}%`;
}
