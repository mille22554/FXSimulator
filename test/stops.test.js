/**
 * 停損 / 停利**價格制**單元驗收（spec §7.5）。
 *
 *   S1  parseStopPrice：空值 → null；非正整數 → invalid
 *   S2  pctOnlyGiven：只送 pct 才回 true
 *   S3  resolveStops：做多 / 做空的方向、最小距離、強平上限對稱
 *   S4  rowToRule：舊 sl_pct / tp_pct 資料換算成價格；新欄位優先
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStopPrice, pctOnlyGiven, resolveStops } from '../src/stops.js';
import { rowToRule } from '../src/db.js';

// 1/10 − 0.2%（與 account.js 的 liquidationDistance 同式）
const LIQ10 = 0.1 - 0.002;

test('S1. parseStopPrice：省略/null/空字串 → null；非正整數 → invalid', () => {
  assert.deepEqual(parseStopPrice(undefined), { value: null });
  assert.deepEqual(parseStopPrice(null), { value: null });
  assert.deepEqual(parseStopPrice(''), { value: null });
  assert.deepEqual(parseStopPrice(49800), { value: 49800 });
  assert.deepEqual(parseStopPrice('49800'), { value: 49800 });
  for (const bad of [0, -1, 49800.5, 'abc', NaN, Infinity]) {
    assert.deepEqual(parseStopPrice(bad), { error: 'invalid' }, `應拒絕 ${bad}`);
  }
});

test('S2. pctOnlyGiven：只有 pct、沒有對應 price 才算', () => {
  assert.equal(pctOnlyGiven(0.5, undefined), true);
  assert.equal(pctOnlyGiven(0.5, 49800), false, '同時給 price → 以 price 為準');
  assert.equal(pctOnlyGiven(undefined, 49800), false);
  assert.equal(pctOnlyGiven(null, null), false);
});

test('S3. resolveStops：做多／做空對稱，方向錯誤與距離限制', () => {
  const ref = 50100;

  // 做多：SL 在下、TP 在上
  assert.deepEqual(
    resolveStops({ slPriceE4: 49800, tpPriceE4: 50400, side: 'long', refPriceE4: ref, liqDist: LIQ10 }),
    { ok: true, slPriceE4: 49800, tpPriceE4: 50400 },
  );
  // 做空：SL 在上、TP 在下
  assert.deepEqual(
    resolveStops({ slPriceE4: 50400, tpPriceE4: 49800, side: 'short', refPriceE4: ref, liqDist: LIQ10 }),
    { ok: true, slPriceE4: 50400, tpPriceE4: 49800 },
  );

  // 方向錯誤
  assert.equal(resolveStops({ slPriceE4: 50200, side: 'long', refPriceE4: ref, liqDist: LIQ10 }).reason, 'sl_wrong_side');
  assert.equal(resolveStops({ tpPriceE4: 50000, side: 'long', refPriceE4: ref, liqDist: LIQ10 }).reason, 'tp_wrong_side');
  assert.equal(resolveStops({ slPriceE4: 50000, side: 'short', refPriceE4: ref, liqDist: LIQ10 }).reason, 'sl_wrong_side');
  assert.equal(resolveStops({ tpPriceE4: 50200, side: 'short', refPriceE4: ref, liqDist: LIQ10 }).reason, 'tp_wrong_side');

  // 距離 < 0.05%
  assert.equal(resolveStops({ slPriceE4: 50099, side: 'long', refPriceE4: ref, liqDist: LIQ10 }).reason, 'sl_too_close');
  assert.equal(resolveStops({ tpPriceE4: 50101, side: 'long', refPriceE4: ref, liqDist: LIQ10 }).reason, 'tp_too_close');

  // 停損超過強平距離 × 0.9（8.82%）
  const beyond = resolveStops({ slPriceE4: 45000, side: 'long', refPriceE4: ref, liqDist: LIQ10 });
  assert.equal(beyond.reason, 'sl_beyond_liq');
  assert.ok(beyond.max > 0);

  // 都不設定 → 合法且為 null
  assert.deepEqual(
    resolveStops({ side: 'long', refPriceE4: ref, liqDist: LIQ10 }),
    { ok: true, slPriceE4: null, tpPriceE4: null },
  );
});

test('S4. rowToRule：舊百分比換算成價格，新欄位優先', () => {
  const base = {
    id: 1, user_id: 1, kind: 'conditional_open', params_json: '{}', enabled: 1,
    created_tick: 0, triggered_tick: null, side: 'long', trigger_price_e4: 50100,
    margin_a: 1000, leverage: 10, status: 'active', armed_side: 'above',
  };

  // 舊資料：sl_pct 0.5（=0.5%）、tp_pct 1（=1%）
  const legacy = rowToRule({ ...base, sl_pct: 0.5, tp_pct: 1, sl_price_e4: null, tp_price_e4: null });
  assert.equal(legacy.slPriceE4, Math.round(50100 * 0.995));
  assert.equal(legacy.tpPriceE4, Math.round(50100 * 1.01));

  // 做空：舊資料的 SL 在上、TP 在下
  const legacyShort = rowToRule({ ...base, side: 'short', sl_pct: 0.5, tp_pct: 1, sl_price_e4: null, tp_price_e4: null });
  assert.equal(legacyShort.slPriceE4, Math.round(50100 * 1.005));
  assert.equal(legacyShort.tpPriceE4, Math.round(50100 * 0.99));

  // 新欄位存在 → 不換算
  const modern = rowToRule({ ...base, sl_pct: 0.5, tp_pct: 1, sl_price_e4: 49800, tp_price_e4: 50400 });
  assert.equal(modern.slPriceE4, 49800);
  assert.equal(modern.tpPriceE4, 50400);
});
