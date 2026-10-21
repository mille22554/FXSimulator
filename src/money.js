/**
 * 金額 / 價格換算與四捨五入工具。
 *
 *  - 金額一律用整數 milli-A（1 A = 1,000）
 *  - 價格一律用整數 e4（5.0000 = 50,000）
 *  - 交易損益（P&L）四捨五入到 milli-A
 *  - 持倉費用以**微 A**計算（1 A = 1,000,000），扣款回毫 A，找零累積
 *    （§5.5 v0.25：`positions.fee_remainder_micro` 是唯一的非毫 A 金額欄位）
 */

import { MILLI_PER_A, MICRO_PER_A, E4, HOURS_PER_YEAR } from './config.js';

/** 1 milli-A = 1,000 微 A */
const MICRO_PER_MILLI = MICRO_PER_A / MILLI_PER_A;

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
 * 每小時持倉費（微 A，1 A = 1,000,000）——§5.5：
 *   fee_micro = floor(notional_milli × rate_num ÷ 8760)
 * @param {number} notionalMilli 名目（milli-A，整數）
 * @param {number} rateNum       年利率 × 1000（做多 26、做空 9）
 * @returns {number} 本小時費用（微 A，整數）
 */
export function hourlyFeeMicro(notionalMilli, rateNum) {
  return Math.floor((notionalMilli * rateNum) / HOURS_PER_YEAR);
}

/**
 * 微 A → 毫 A 扣款 + 找零（§5.5）：
 *   fee_milli          = floor((fee_micro + fee_remainder_micro) ÷ 1000)
 *   fee_remainder_micro = (fee_micro + fee_remainder_micro) % 1000
 * @param {number} feeMicro       本次費用（微 A，整數）
 * @param {number} remainderMicro 上期找零（微 A，整數，預設 0）
 * @returns {{chargeMilli: number, remainderMicro: number}} 扣款（毫 A）與新找零（微 A）
 */
export function chargeFromMicro(feeMicro, remainderMicro = 0) {
  const total = feeMicro + remainderMicro;
  return {
    chargeMilli: Math.floor(total / MICRO_PER_MILLI),
    remainderMicro: total % MICRO_PER_MILLI,
  };
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
