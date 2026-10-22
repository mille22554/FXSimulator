/**
 * 停損 / 停利驗證（**價格制**，對齊元大 CFD：使用者輸入絕對價位）。
 *
 * 契約（單一真相）：
 *   - 輸入：`sl_price_e4` / `tp_price_e4`（整數 e4 價格；4.9500 → 49500），可省略或 null
 *   - 舊的 `sl_pct` / `tp_pct`（百分比制）**已移除** → 呼叫端回 `sl_pct_removed` / `tp_pct_removed`
 *
 * 驗證規則（以「參考價」`refPriceE4` 判斷）：
 *   停損 sl：
 *     - 必須是正整數 → 否則 `sl_invalid`
 *     - 方向：long 必須 `sl < ref`、short 必須 `sl > ref` → 否則 `sl_wrong_side`
 *     - 距離 `d = |ref − sl| / ref`
 *       - `d < MIN_SL_DISTANCE`（0.05%）→ `sl_too_close`（附 `min`）
 *       - `d > liqDist × SL_MAX_LIQ_FACTOR` → `sl_beyond_liq`（附 `max`）
 *   停利 tp：
 *     - 必須是正整數 → 否則 `tp_invalid`
 *     - 方向：long 必須 `tp > ref`、short 必須 `tp < ref` → 否則 `tp_wrong_side`
 *     - 距離 `d` 不得小於 `MIN_SL_DISTANCE` → 否則 `tp_too_close`（附 `min`）
 *       （避免價差／自身衝擊讓停利一開倉就觸發）
 *
 * `liqDist`（強平距離）**由呼叫端傳入**：本檔若從 `account.js` import 會形成
 * `account.js` ↔ `stops.js` 的循環 import，故只 import `config.js` 的常數。
 */

import { MIN_SL_DISTANCE, SL_MAX_LIQ_FACTOR } from './config.js';

/**
 * 解析停損／停利價格（整數 e4）。
 * undefined / null / '' → `{ value: null }`（未設定停損停利）
 * 有值但不是正整數 → `{ error: 'invalid' }`
 * @param {unknown} raw
 * @returns {{value: number|null}|{error: 'invalid'}}
 */
export function parseStopPrice(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return { error: 'invalid' };
  return { value: n };
}

/**
 * 舊的百分比欄位是否「只送 pct、沒送對應 price」→ 呼叫端應回 `*_pct_removed`。
 * @param {unknown} pctRaw
 * @param {unknown} priceRaw
 * @returns {boolean}
 */
export function pctOnlyGiven(pctRaw, priceRaw) {
  const pctGiven = pctRaw !== undefined && pctRaw !== null && pctRaw !== '';
  const priceGiven = priceRaw !== undefined && priceRaw !== null && priceRaw !== '';
  return pctGiven && !priceGiven;
}

/**
 * 驗證停損 / 停利（價格制）。
 * @param {object} opts
 * @param {number|null} opts.slPriceE4 停損價（e4 整數；null = 不設）
 * @param {number|null} opts.tpPriceE4 停利價（e4 整數；null = 不設）
 * @param {'long'|'short'} opts.side 方向
 * @param {number} opts.refPriceE4 參考價（e4 整數）：手動開倉＝下單前現價；規則＝觸發價
 * @param {number} opts.liqDist 強平距離（1/槓桿 − 0.2%），**由呼叫端傳入**
 * @returns {{ok:true, slPriceE4:number|null, tpPriceE4:number|null}
 *          |{ok:false, reason:string, min?:number, max?:number}}
 */
export function resolveStops({ slPriceE4, tpPriceE4, side, refPriceE4, liqDist }) {
  const sl = resolveOne('sl', slPriceE4, { side, refPriceE4, liqDist });
  if (!sl.ok) return sl;
  const tp = resolveOne('tp', tpPriceE4, { side, refPriceE4, liqDist });
  if (!tp.ok) return tp;
  return { ok: true, slPriceE4: sl.priceE4, tpPriceE4: tp.priceE4 };
}

/**
 * 單一停損／停利的驗證。
 * @param {'sl'|'tp'} kind
 * @returns {{ok:true, priceE4:number|null}|{ok:false, reason:string, min?:number, max?:number}}
 */
function resolveOne(kind, raw, { side, refPriceE4, liqDist }) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, priceE4: null };

  const parsed = parseStopPrice(raw);
  if (parsed.error) return { ok: false, reason: `${kind}_invalid` };
  const priceE4 = parsed.value;

  const ref = Number(refPriceE4);
  if (!Number.isFinite(ref) || ref <= 0) return { ok: false, reason: `${kind}_invalid` };

  const long = side === 'long';
  // 方向檢查：停損在「虧損方向」、停利在「獲利方向」
  const wrongSide =
    kind === 'sl'
      ? (long ? priceE4 >= ref : priceE4 <= ref)
      : (long ? priceE4 <= ref : priceE4 >= ref);
  if (wrongSide) return { ok: false, reason: `${kind}_wrong_side` };

  const dist = Math.abs(ref - priceE4) / ref;
  if (dist < MIN_SL_DISTANCE) {
    return { ok: false, reason: `${kind}_too_close`, min: MIN_SL_DISTANCE };
  }
  if (kind === 'sl') {
    const max = (Number.isFinite(liqDist) ? liqDist : 0) * SL_MAX_LIQ_FACTOR;
    if (dist > max) return { ok: false, reason: 'sl_beyond_liq', max };
  }
  return { ok: true, priceE4 };
}

export default { resolveStops, parseStopPrice, pctOnlyGiven };
