/**
 * 驗收情境（spec §10 的經濟正確性條目）。
 * 每個情境都回傳一份可印出的報告，CLI `scenario` 會直接使用。
 */

import { formatE4, formatMilli, formatPct } from './money.js';

function priceLine(label, price) {
  return `  ${label}: ${price.toFixed(4)}`;
}

/** §10：開多 → 立刻平倉，淨損益必為負 */
export function scenarioRoundtrip(engine, { marginA = 10_000, leverage = 10 } = {}) {
  const acct = engine.ensureAccount();
  const before = acct.availableMilli(engine.ticksExecuted);
  const open = engine.open(engine.userId, { side: 'long', marginA, leverage });
  if (!open.ok) return { name: 'roundtrip', error: open.reason };
  const close = engine.close(engine.userId, open.position.id);
  const after = acct.availableMilli(engine.ticksExecuted);
  return {
    name: 'roundtrip',
    entryPriceE4: open.entryPriceE4,
    exitPriceE4: close.exitPriceE4,
    pnlMilli: close.pnlMilli,
    balanceDeltaMilli: after - before,
    pass: close.pnlMilli < 0,
    lines: [
      `  名目 ${formatMilli(open.notionalMilli)} @ ${formatE4(open.entryPriceE4)}`,
      `  平倉 ${formatE4(close.exitPriceE4)}`,
      `  淨損益 ${formatMilli(close.pnlMilli)}（餘額變化 ${formatMilli(after - before)}）`,
      `  結論：${close.pnlMilli < 0 ? '淨損益 < 0 ✔' : '淨損益 ≥ 0 ✘'}`,
    ],
  };
}

/** §10：玩家把價格推到上限再平倉，淨損益 < 0 */
export function scenarioPump(engine, { leverage = 10 } = {}) {
  const acct = engine.ensureAccount();
  const before = acct.availableMilli(engine.ticksExecuted);
  const max = engine.maxOpenNotional(engine.userId, leverage);
  const baseBefore = engine.market.basePrice;
  const open = engine.open(engine.userId, {
    side: 'long',
    marginA: max.marginA,
    leverage,
  });
  if (!open.ok) return { name: 'pump', error: open.reason };
  const peakPrice = engine.market.price;
  const peakImpact = engine.market.impactMultiplier() - 1;
  const close = engine.close(engine.userId, open.position.id);
  const after = acct.availableMilli(engine.ticksExecuted);
  return {
    name: 'pump',
    notionalMilli: open.notionalMilli,
    peakPrice,
    peakImpact,
    pnlMilli: close.pnlMilli,
    balanceDeltaMilli: after - before,
    pass: close.pnlMilli < 0,
    lines: [
      `  基準價 ${baseBefore.toFixed(4)} → 推高後 ${peakPrice.toFixed(4)}（衝擊 ${formatPct(peakImpact)}）`,
      `  名目 ${formatMilli(open.notionalMilli)}，保證金 ${formatMilli(open.marginMilli)}`,
      `  平倉 ${formatE4(close.exitPriceE4)}，淨損益 ${formatMilli(close.pnlMilli)}`,
      `  結論：${close.pnlMilli < 0 ? '淨損益 < 0 ✔' : '淨損益 ≥ 0 ✘'}`,
    ],
  };
}

/** §10：100 倍逆向 → 強平，且只沒收該單保證金 */
export function scenarioLiquidation(engine, { marginA = 1000, leverage = 100, shock = -0.01 } = {}) {
  const acct = engine.ensureAccount();
  const before = acct.availableMilli(engine.ticksExecuted);
  const open = engine.open(engine.userId, { side: 'long', marginA, leverage });
  if (!open.ok) return { name: 'liquidation', error: open.reason };
  const liqPrice = open.position.liqPriceE4 / 10000;
  engine.applyShock(shock);
  const liquidations = engine.runLiquidations();
  const after = acct.availableMilli(engine.ticksExecuted);
  const liq = liquidations[0];
  return {
    name: 'liquidation',
    liquidated: liquidations.length > 0,
    pnlMilli: liq?.pnlMilli ?? 0,
    balanceDeltaMilli: after - before,
    pass: liquidations.length > 0,
    lines: [
      `  名目 ${formatMilli(open.notionalMilli)} @ ${formatE4(open.entryPriceE4)}，強平價 ${liqPrice.toFixed(4)}`,
      `  注入跳空 ${formatPct(shock)} → 觸發強平：${liquidations.length > 0 ? '是' : '否'}`,
      `  強平損益 ${formatMilli(liq?.pnlMilli ?? 0)}（保證金 ${formatMilli(open.marginMilli)}）`,
      `  餘額變化 ${formatMilli(after - before)}`,
    ],
  };
}

/** §10：4% 跳空 → 虧損超過保證金，餘額可為負，欠款期間不能開新倉 */
export function scenarioGap(engine, { marginA = 30_000, leverage = 100, shock = -0.04 } = {}) {
  const acct = engine.ensureAccount();
  const before = acct.availableMilli(engine.ticksExecuted);
  const open = engine.open(engine.userId, { side: 'long', marginA, leverage });
  if (!open.ok) return { name: 'gap', error: open.reason };
  engine.applyShock(shock);
  const liquidations = engine.runLiquidations();
  const after = acct.availableMilli(engine.ticksExecuted);
  const reopen = engine.open(engine.userId, { side: 'long', marginA: 1000, leverage: 10 });
  return {
    name: 'gap',
    liquidated: liquidations.length > 0,
    balanceMilli: after,
    balanceDeltaMilli: after - before,
    reopenRejected: !reopen.ok,
    pass: liquidations.length > 0 && after < 0 && !reopen.ok,
    lines: [
      `  名目 ${formatMilli(open.notionalMilli)}，保證金 ${formatMilli(open.marginMilli)}`,
      `  注入跳空 ${formatPct(shock)} → 強平：${liquidations.length > 0 ? '是' : '否'}`,
      `  餘額 ${formatMilli(after)}（變化 ${formatMilli(after - before)}）`,
      `  欠款期間再開倉：${!reopen.ok ? `被拒（${reopen.reason}）✔` : '竟然成功 ✘'}`,
    ],
  };
}

/** §10：兩個玩家對做，價格影響互相抵銷 */
export function scenarioOpposing(engine, { notionalA = 100_000, leverage = 10 } = {}) {
  // 情境專用帳號（避免受既有欠款影響）
  const userA = 901;
  const userB = 902;
  engine.resetAccount(userA);
  engine.resetAccount(userB);
  const baseBefore = engine.market.basePrice;
  const marginA = notionalA / leverage;
  const a = engine.open(userA, { side: 'long', marginA, leverage });
  if (!a.ok) return { name: 'opposing', error: a.reason };
  const midAfterA = engine.market.price;
  const b = engine.open(userB, { side: 'short', marginA, leverage });
  if (!b.ok) return { name: 'opposing', error: b.reason };
  const impact = engine.market.impactMultiplier() - 1;
  return {
    name: 'opposing',
    impact,
    netNotionalA: engine.market.netNotionalA,
    pass: Math.abs(impact) < 1e-12 && Math.abs(engine.market.netNotionalA) < 1e-9,
    lines: [
      `  A 開多 ${formatMilli(a.notionalMilli)} → 價格 ${midAfterA.toFixed(4)}（衝擊 ${formatPct(midAfterA / baseBefore - 1)}）`,
      `  B 開空 ${formatMilli(b.notionalMilli)} → 價格 ${engine.market.price.toFixed(4)}`,
      `  全服淨部位 ${formatMilli(Math.round(engine.market.netNotionalA * 1000))}，殘餘衝擊 ${formatPct(impact, 6)}`,
      `  結論：${Math.abs(impact) < 1e-12 ? '影響互相抵銷 ✔' : '仍有殘餘影響 ✘'}`,
    ],
  };
}

export const SCENARIOS = {
  roundtrip: scenarioRoundtrip,
  pump: scenarioPump,
  liquidation: scenarioLiquidation,
  gap: scenarioGap,
  opposing: scenarioOpposing,
};

export function runScenario(engine, name, opts = {}) {
  const fn = SCENARIOS[name];
  if (!fn) throw new Error(`unknown scenario: ${name}`);
  return fn(engine, opts);
}
