/**
 * 停損 / 停利百分比解析（M2、M3 共用）。
 *
 * `sl_pct` / `tp_pct` 的解讀（contract 請求範例：`"sl_pct": 0.5` = 0.5%）：
 *
 * 規則（決定性）：
 *   1. **主解讀 = 百分比數字**（0.5 → 0.005 小數比例），與 contract 的請求範例一致。
 *   2. 若百分比解讀違反引擎限制（太小 / 超過強平距離）但「小數比例」解讀合法，
 *      則採小數比例（相容另一種前端寫法）。
 *   3. 兩者都不合法 → 交給引擎產生正確的拒絕原因。
 *
 * 回傳值為**小數比例**（0.005 = 0.5%），與引擎內部（§5.1）一致。
 */

import { MIN_SL_DISTANCE, SL_MAX_LIQ_FACTOR } from './config.js';
import { liquidationDistance } from './account.js';

/**
 * @param {number|string|null|undefined} raw 輸入值（百分比數字優先）
 * @param {object} opts
 * @param {'sl'|'tp'} opts.kind
 * @param {number} opts.leverage 槓桿（決定停損上限）
 * @returns {{value: number|null}|{error: string}}
 */
export function resolvePct(raw, { kind, leverage }) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { error: `${kind}_invalid` };

  const percent = n / 100;
  const fraction = n;

  if (kind === 'sl') {
    const maxFraction = liquidationDistance(leverage) * SL_MAX_LIQ_FACTOR;
    const ok = (v) => v >= MIN_SL_DISTANCE && v <= maxFraction;
    if (ok(percent)) return { value: percent };
    if (ok(fraction)) return { value: fraction };
    return { value: percent };
  }

  // tp：引擎只要求 > 0；百分比解讀小於 0.05%（低於最小停損距離）時改採小數比例
  if (percent >= MIN_SL_DISTANCE) return { value: percent };
  if (fraction <= 1) return { value: fraction };
  return { value: percent };
}

export default { resolvePct };
