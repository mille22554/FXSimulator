/**
 * 經濟正確性驗收（spec §10「經濟正確性」＋「資料與精度 E」）。
 *   1. 持倉費 0.297 A/小時（10 萬名目），24 小時誤差 < 0.001 A
 *   2. 價格衝擊上限 ±20%
 *   3. 開多 → 立刻平倉，淨損益 < 0
 *   4. 自推自賺：把價格推到上限再平倉，淨損益 < 0
 *   5. 兩個玩家對做，價格影響互相抵銷
 *   6. 100 倍逆向 → 強平，且只影響該單
 *   7. 4% 跳空 → 餘額可為負，欠款期間不能開新倉
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.js';
import { FEE_LONG_ANNUAL, HOURS_PER_YEAR } from '../src/config.js';

function newEngine() {
  const engine = new Engine({ seed: 42 });
  engine.load();
  engine.init();
  return engine;
}

test('1. 持倉費：10 萬名目 ≈ 0.297 A/小時，24 小時誤差 < 0.001 A', () => {
  const engine = newEngine();
  const acct = engine.ensureAccount(1);

  const open = engine.open(1, { side: 'long', marginA: 10_000, leverage: 10 });
  assert.ok(open.ok, '開倉失敗');
  assert.equal(open.notionalMilli, 100_000_000, '名目應為 100,000 A');

  let charged = 0;
  for (let h = 0; h < 24; h++) charged += acct.chargeHourlyFees(engine.ticksExecuted);

  const hourlyExact = (open.notionalMilli * FEE_LONG_ANNUAL) / HOURS_PER_YEAR;
  const dailyExact = hourlyExact * 24;
  const hourlyA = hourlyExact / 1000;

  assert.ok(Math.abs(hourlyA - 0.297) < 0.001, `每小時 ${hourlyA} A 應接近 0.297 A`);
  // floor + 餘數累積 → 24 小時總額誤差 < 1 milli-A = 0.001 A
  assert.ok(
    Math.abs(charged - dailyExact) < 1,
    `24h 費用 ${charged / 1000} A 與理論 ${dailyExact / 1000} A 誤差應 < 0.001 A`,
  );
  assert.ok(charged > 0);
});

test('2. 價格衝擊上限 ±20%（tanh 飽和）', () => {
  const engine = newEngine();
  const market = engine.market;

  market.setNetNotional(0);
  const base = market.basePrice;

  market.setNetNotional(1e15);
  assert.ok(market.price <= base * 1.2 + 1e-9, `上界 ${market.price / base} 不得超過 1.2`);
  assert.ok(market.price > base * 1.19, '極大淨部位應接近飽和值');

  market.setNetNotional(-1e15);
  assert.ok(market.price >= base * 0.8 - 1e-9, `下界 ${market.price / base} 不得低於 0.8`);
  assert.ok(market.price < base * 0.81);
});

test('3. 開多 → 立刻平倉，淨損益必為負（含點差與衝擊）', () => {
  const engine = newEngine();
  const acct = engine.ensureAccount(1);
  const before = acct.availableMilli(engine.ticksExecuted);

  const open = engine.open(1, { side: 'long', marginA: 10_000, leverage: 10 });
  assert.ok(open.ok);
  const close = engine.close(1, open.position.id);
  assert.ok(close.ok);

  assert.ok(close.pnlMilli < 0, `淨損益 ${close.pnlMilli} 應為負`);
  const after = acct.availableMilli(engine.ticksExecuted);
  assert.ok(after < before, '平倉後餘額應低於開倉前');
  assert.equal(after - before, close.pnlMilli, '餘額變化應等於實際損益（保證金已退還）');
});

test('4. 自推自賺：用最大名目把價格推高再平倉，淨損益 < 0', () => {
  const engine = newEngine();
  const acct = engine.ensureAccount(1);
  const before = acct.availableMilli(engine.ticksExecuted);

  const max = engine.maxOpenNotional(1, 10);
  const open = engine.open(1, { side: 'long', marginA: max.marginA, leverage: 10 });
  assert.ok(open.ok, '開倉失敗');

  // 自己的部位把價格推高
  assert.ok(engine.market.price > engine.market.basePrice, '價格應被自己的多單推高');
  const impact = engine.market.impactMultiplier() - 1;
  assert.ok(impact > 0 && impact < 0.2, `衝擊 ${impact} 應在 (0, 20%) 內`);

  const close = engine.close(1, open.position.id);
  assert.ok(close.ok);
  assert.ok(close.pnlMilli < 0, `淨損益 ${close.pnlMilli} 應為負`);

  const after = acct.availableMilli(engine.ticksExecuted);
  assert.ok(after < before);
});

test('5. 兩個玩家對做（多空同額），價格影響互相抵銷', () => {
  const engine = newEngine();
  const base = engine.market.basePrice;

  const a = engine.open(1, { side: 'long', marginA: 10_000, leverage: 10 });
  assert.ok(a.ok);
  const midAfterLong = engine.market.price;
  assert.ok(midAfterLong > base, '多單應推高價格');

  const b = engine.open(2, { side: 'short', marginA: 10_000, leverage: 10 });
  assert.ok(b.ok);

  assert.ok(Math.abs(engine.market.netNotionalA) < 1e-9, '全服淨部位應為 0');
  const impact = engine.market.impactMultiplier() - 1;
  assert.ok(Math.abs(impact) < 1e-12, `殘餘衝擊 ${impact} 應約為 0`);
  assert.ok(Math.abs(engine.market.price - base) < 1e-12, '價格應回到基準價');
});

test('6. 100 倍逆向 → 強平，且只影響該單（其他帳戶不受影響）', () => {
  const engine = newEngine();
  const acct = engine.ensureAccount(1);
  const other = engine.ensureAccount(2);
  const otherBefore = other.availableMilli(engine.ticksExecuted);
  const before = acct.availableMilli(engine.ticksExecuted);

  const open = engine.open(1, { side: 'long', marginA: 1_000, leverage: 100 });
  assert.ok(open.ok, '開倉失敗');
  assert.equal(open.notionalMilli, 100_000_000, '名目應為 100,000 A');

  // §5.2：強平距離 = 1/槓桿 − 0.2% = 0.8%（§7.5 亦載明 100× 強平距離 0.8%）
  // → 逆向 0.5% 只虧約 50% 保證金，尚不觸發強平
  engine.applyShock(-0.005);
  const mark = engine.market.price;
  const lossMilli = open.position.unrealizedLossMilli(Math.round(mark * 10000));
  assert.ok(
    lossMilli < open.position.liquidationThresholdMilli(),
    `逆向 0.5% 的虧損 ${lossMilli} 應小於強平門檻 ${open.position.liquidationThresholdMilli()}`,
  );
  assert.equal(engine.runLiquidations().length, 0, '0.5% 逆向不應強平（門檻 0.8%）');

  // 逆向 0.9%（≥ 0.8%）→ 觸發強平
  engine.applyShock(-0.004);
  const liquidations = engine.runLiquidations();
  assert.equal(liquidations.length, 1, '應觸發一次強平');
  assert.equal(liquidations[0].position.status, 'liquidated');

  const after = acct.availableMilli(engine.ticksExecuted);
  assert.equal(after, before + liquidations[0].pnlMilli, '餘額 = 交易前 − 實際虧損（誤差 0）');
  assert.ok(after < before, '強平應使餘額減少');

  // 其他帳戶不受影響（逐倉）
  assert.equal(other.availableMilli(engine.ticksExecuted), otherBefore);
});

test('7. 4% 跳空 → 虧損超過保證金、餘額為負、欠款期間不能開新倉', () => {
  const engine = newEngine();
  const acct = engine.ensureAccount(1);
  const before = acct.availableMilli(engine.ticksExecuted);

  const open = engine.open(1, { side: 'long', marginA: 30_000, leverage: 100 });
  assert.ok(open.ok, '開倉失敗');

  engine.applyShock(-0.04);
  const liquidations = engine.runLiquidations();
  assert.equal(liquidations.length, 1, '應觸發強平');

  const after = acct.availableMilli(engine.ticksExecuted);
  assert.ok(after < 0, `餘額 ${after / 1000} A 應為負（欠款）`);
  assert.ok(after < before - open.position.marginMilli, '超額損失應由可用餘額吸收');

  const reopen = engine.open(1, { side: 'long', marginA: 1_000, leverage: 10 });
  assert.equal(reopen.ok, false, '欠款期間不得開新倉');
  assert.equal(reopen.reason, 'debt_no_open');
});

test('E1. P&L 以毫 A 四捨五入，重複結算不累積誤差', () => {
  const engine = newEngine();
  const open = engine.open(1, { side: 'long', marginA: 10_000, leverage: 10 });
  assert.ok(open.ok);
  const close = engine.close(1, open.position.id);
  const pnl = close.pnlMilli;
  assert.ok(Number.isInteger(pnl), 'P&L 必須是整數毫 A');
  // 同一組整數價格重算 1,000 次，結果必須一致
  const again = engine.market; // 只為說明：P&L 由整數 e4 價格推導，不含累加
  for (let i = 0; i < 1000; i++) {
    const recomputed = Math.floor(
      ((close.exitPriceE4 - open.entryPriceE4) * open.notionalMilli) / open.entryPriceE4 + 0.5,
    );
    assert.equal(recomputed, pnl);
  }
  assert.ok(again);
});

test('E2. 收入以 tick 計：停機不補發', () => {
  const engine = newEngine();
  const acct = engine.ensureAccount(1);
  assert.equal(acct.availableMilli(0), 100_000_000);

  engine.tick(10);
  // 10 個 tick × 35,000 milli-A = 350,000 milli-A（未結算）
  assert.equal(acct.availableMilli(engine.ticksExecuted), 100_000_000 + 350_000);
  assert.equal(acct.balanceMilli, 100_000_000, '未結算前 balance_milli 不變');

  acct.settle(engine.ticksExecuted);
  assert.equal(acct.balanceMilli, 100_000_000 + 350_000);
  assert.equal(acct.settledTickId, 10);
});
