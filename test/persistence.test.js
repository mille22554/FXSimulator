/**
 * 持久化 / 連續世界驗收（spec §4.4、§5.4、§10）。
 *   8. 重啟後 tick_id 接續、停機期間不發收入
 *   9. 60 個 tick → 恰好一根 1 分 K 線，且 OHLC 正確
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from '../src/engine.js';
import { openSqliteStore } from '../src/db.js';
import { priceToE4 } from '../src/money.js';

let sqliteAvailable = true;
try {
  await import('better-sqlite3');
} catch {
  sqliteAvailable = false;
}

test('8. 重啟後 tick_id 接續、停機期間不發收入', { skip: !sqliteAvailable && 'better-sqlite3 不可用' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxsim-m1-'));
  const dbPath = join(dir, 'fxsim.db');
  let store1 = null;
  let store2 = null;
  try {
    // ---- 第一次開機 ----
    store1 = await openSqliteStore(dbPath);
    const e1 = new Engine({ seed: 42, store: store1 });
    e1.load();
    e1.init();
    e1.tick(120); // 2 分鐘 → 已封存 2 根 K 線
    const acct1 = e1.ensureAccount(1);
    acct1.settle(e1.ticksExecuted);
    const balanceBefore = acct1.balanceMilli;
    const settledBefore = acct1.settledTickId;
    const ticksBefore = e1.ticksExecuted;
    e1.persist();
    store1.close();
    store1 = null;

    // ---- 停機（不跑任何 tick）→ 重開 ----
    store2 = await openSqliteStore(dbPath);
    const e2 = new Engine({ seed: 42, store: store2 });
    e2.load();
    e2.init();
    const acct2 = e2.ensureAccount(1);

    assert.equal(e2.ticksExecuted, ticksBefore, 'tick_id 必須接續，不可歸零');
    assert.equal(acct2.balanceMilli, balanceBefore, '餘額必須與重啟前一致');
    assert.equal(acct2.settledTickId, settledBefore);
    // 停機期間不發收入：可用餘額與重啟前完全相同
    assert.equal(acct2.availableMilli(e2.ticksExecuted), balanceBefore, '停機期間不得補發收入');

    // 市場也接續（tick 繼續跑，價格不跳躍）
    e2.tick(1);
    assert.equal(e2.ticksExecuted, ticksBefore + 1);
    assert.equal(e2.candles(100).length, 2, '應沿用既有 K 線，不重複產生');
  } finally {
    store1?.close();
    store2?.close();
    // Windows 上 SQLite 的 WAL 句柄可能尚未釋放，清理失敗不影響測試結果
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* ignore cleanup error */
    }
  }
});

test('9. 60 個 tick → 恰好一根 1 分 K 線，OHLC 正確', () => {
  const engine = new Engine({ seed: 42 });
  engine.load();
  engine.init();

  const prices = [];
  for (let i = 0; i < 60; i++) {
    engine.tick(1);
    prices.push(engine.market.price);
  }

  const candles = engine.candles(100);
  assert.equal(candles.length, 1, '60 個 tick 應只有一根 K 線');
  const c = candles[0];
  assert.equal(c.minute_id, 0);

  const e4s = prices.map(priceToE4);
  assert.equal(c.open_e4, e4s[0], 'open 應為分鐘第一個價格');
  assert.equal(c.close_e4, e4s[e4s.length - 1], 'close 應為分鐘最後一個價格');
  assert.equal(c.high_e4, Math.max(...e4s), 'high 應為期間最高');
  assert.equal(c.low_e4, Math.min(...e4s), 'low 應為期間最低');
  assert.equal(c.volume_notional_milli, 0, '本分鐘沒有成交');
  assert.equal(c.net_notional_milli, 0, '本分鐘沒有部位');

  // 再跑 60 tick → 第二根
  engine.tick(60);
  assert.equal(engine.candles(100).length, 2, '每分鐘恰好一根');
});
