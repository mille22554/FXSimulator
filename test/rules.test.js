/**
 * M3 驗收（contract「M3 acceptance」＋ spec §6.3 / §6.4 / §10「離線規則」）。
 *
 *   R1  每帳號最多 2 條啟用中的條件開倉規則（已觸發／已取消不佔額度）
 *   R2  觸發判定用 tick 的 last price；成交在**下一 tick**（一次性）
 *   R3  滑價 0.1% **只在變差時**加（買進 / 賣出對稱）
 *   R4  成交失敗（餘額不足）→ 規則維持 active + last_error；通知每 5 分鐘最多一次
 *   R5  強平暫停所有啟用中規則；手動重新啟用可恢復
 *   R6  離線報告形狀（收入 / 權益高低 / 觸發明細 / 是否強平）
 *   R7  REST：GET/POST/PATCH/DELETE /api/rules（穩定原因字串）
 *   R8  WS：rule.upsert / rule.delete / rule.updated / rule.triggered / rule.skipped；snapshot 含 rules
 *   R9  觸發價離現價 < 0.05% → 拒絕 trigger_too_close
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

import { buildServer } from '../src/server.js';
import { Engine } from '../src/engine.js';
import { openSqliteStore } from '../src/db.js';
import { INCOME_MILLI_PER_TICK, RULE_SLIPPAGE } from '../src/config.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 新引擎（記憶體 store） */
function newEngine() {
  const engine = new Engine({ seed: 42 });
  engine.load();
  engine.init();
  return engine;
}

/**
 * 把價格「凍結」在指定值（每個 tick 的 market step 都重設成該價），
 * 讓觸發判定與成交價可被精確驗證。
 */
function freezePrice(engine, price) {
  const apply = () => {
    engine.market.mu = Math.log(price);
    engine.market.x = 0;
    engine.market.components = [];
    engine.market.netNotionalA = 0;
    engine.market.recomputePrice();
  };
  engine.market.step = () => apply();
  apply();
}

/** 目前 tick id（與 API 的 tick_id 同一時鐘） */
function tickId(engine) {
  return Math.max(0, engine.ticksExecuted - 1);
}

/** 建立一條規則（引擎層） */
function makeRule(engine, userId, input) {
  const result = engine.rules.createRule(userId, input);
  assert.ok(result.ok, `規則建立失敗：${result.reason}`);
  return result.rule;
}

async function withServer(fn, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fxsim-m3-'));
  const dbPath = join(dir, 'fxsim.db');
  const ctx = await buildServer({ dbPath, live: false, ...options });
  try {
    await fn(ctx);
  } finally {
    ctx.hub?.stop();
    await ctx.app.close();
    ctx.store.close?.();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* ignore cleanup error */
    }
  }
}

function json(res) {
  return JSON.parse(res.body);
}

function makeQueue(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  return {
    next(timeoutMs = 5000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 WS 訊息逾時')), timeoutMs);
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    },
    drain() {
      return queue.splice(0, queue.length);
    },
  };
}

async function connectWs(port, userId = 1) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?user=${userId}`);
  const queue = makeQueue(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, queue };
}

/** 等待特定類型的 WS 訊息（略過其他類型） */
async function nextOfType(queue, type, timeoutMs = 5000) {
  return nextWhere(queue, (m) => m.type === type, timeoutMs, type);
}

/** 等待符合條件的 WS 訊息 */
async function nextWhere(queue, predicate, timeoutMs = 5000, label = '訊息') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let msg = null;
    try {
      msg = await queue.next(Math.max(50, deadline - Date.now()));
    } catch {
      break;
    }
    if (predicate(msg)) return msg;
  }
  throw new Error(`等待 WS ${label} 逾時`);
}

// ---------------------------------------------------------------------------
// R1：2 條啟用上限
// ---------------------------------------------------------------------------
test('R1. 每帳號最多 2 條啟用中的條件開倉規則（第 3 條 → max_active_rules）', () => {
  const engine = newEngine();
  freezePrice(engine, 5.0);

  const r1 = makeRule(engine, 1, { side: 'long', trigger_price_e4: 51000, margin_a: 1000, leverage: 10 });
  const r2 = makeRule(engine, 1, { side: 'short', trigger_price_e4: 49000, margin_a: 1000, leverage: 10 });
  assert.equal(r1.status, 'active');
  assert.equal(r2.status, 'active');
  assert.equal(engine.rules.activeCount(1), 2);

  const third = engine.rules.createRule(1, {
    side: 'long', trigger_price_e4: 52000, margin_a: 1000, leverage: 10,
  });
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'max_active_rules');

  // 取消一條 → 又可建立
  const cancelled = engine.rules.cancelRule(1, r1.id);
  assert.ok(cancelled.ok);
  assert.equal(cancelled.rule.status, 'cancelled');
  assert.equal(engine.rules.activeCount(1), 1);
  const fourth = engine.rules.createRule(1, {
    side: 'long', trigger_price_e4: 52000, margin_a: 1000, leverage: 10,
  });
  assert.ok(fourth.ok, '已取消的規則不佔額度');

  // 其他帳號不受影響
  const other = engine.rules.createRule(2, {
    side: 'long', trigger_price_e4: 52000, margin_a: 1000, leverage: 10,
  });
  assert.ok(other.ok, '額度是 per user');
});

// ---------------------------------------------------------------------------
// R2：觸發判定 + 下一 tick 成交 + 一次性
// ---------------------------------------------------------------------------
test('R2. 觸發判定用 tick 的 last price；成交在下一 tick；一次性不重複觸發', () => {
  const engine = newEngine();
  freezePrice(engine, 5.0);
  const rule = makeRule(engine, 1, {
    side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10,
  });
  assert.equal(rule.armedSide, 'above', '觸發價在現價之上 → armed_side=above');

  // tick 1：價格 5.0000 < 觸發價 5.0100 → 不觸發
  engine.tick(1);
  assert.equal(engine.rules.get(rule.id).status, 'active', '未碰到觸發價');
  assert.equal(engine.accounts.get(1).openPositions().length, 0);

  // tick 2：價格升到 5.0110 → 碰到觸發價 → 觸發（但尚未成交）
  freezePrice(engine, 5.011);
  engine.tick(1);
  const triggered = engine.rules.get(rule.id);
  assert.equal(triggered.status, 'triggered', '碰到觸發價即觸發');
  assert.equal(triggered.triggeredTick, tickId(engine), 'triggered_tick = 觸發當下的 tick');
  assert.equal(engine.accounts.get(1).openPositions().length, 0, '成交必須在下一 tick');

  // tick 3：成交
  engine.tick(1);
  const positions = engine.accounts.get(1).openPositions();
  assert.equal(positions.length, 1, '下一 tick 才成交');
  assert.equal(positions[0].side, 'long');
  assert.equal(positions[0].ruleId, rule.id, '部位必須記錄是哪條規則開的');
  assert.equal(engine.rules.get(rule.id).status, 'triggered');

  // 一次性：之後價格再上去也不會再開倉
  freezePrice(engine, 5.05);
  engine.tick(5);
  assert.equal(engine.accounts.get(1).openPositions().length, 1, '一次性：不會再觸發');
  assert.equal(engine.rules.get(rule.id).status, 'triggered');
});

// ---------------------------------------------------------------------------
// R3：滑價只在變差時
// ---------------------------------------------------------------------------
test('R3a. 買進：下一 tick 價格高於觸發價才加 0.1% 滑價', () => {
  const engine = newEngine();
  freezePrice(engine, 5.0);
  const rule = makeRule(engine, 1, {
    side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10,
  });

  freezePrice(engine, 5.011); // 碰到觸發價（5.0100）
  engine.tick(1);
  assert.equal(engine.rules.get(rule.id).status, 'triggered');

  // 成交 tick：價格 5.0120 > 觸發價 5.0100 → 成交價 = 5.0120 × 1.001
  freezePrice(engine, 5.012);
  engine.tick(1);
  const pos = engine.accounts.get(1).openPositions()[0];
  const expected = Math.round(5.012 * (1 + RULE_SLIPPAGE) * 10000);
  assert.equal(pos.entryPriceE4, expected, `成交價應為 next × 1.001（${expected}）`);
});

test('R3b. 買進：下一 tick 價格低於觸發價 → 照該價成交（不加滑價）', () => {
  const engine = newEngine();
  freezePrice(engine, 5.0);
  const rule = makeRule(engine, 1, {
    side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10,
  });

  freezePrice(engine, 5.011); // 碰到觸發價
  engine.tick(1);
  assert.equal(engine.rules.get(rule.id).status, 'triggered');

  freezePrice(engine, 4.999); // 成交 tick 價格低於觸發價 → 不加滑價
  engine.tick(1);
  const pos = engine.accounts.get(1).openPositions()[0];
  assert.equal(pos.entryPriceE4, 49990, '成交價 = 下一 tick 的價格（不加滑價）');
});

test('R3c. 賣出：下一 tick 價格低於觸發價才減 0.1% 滑價；高於則照價成交', () => {
  // 賣出 + 價格低於觸發價 → 減 0.1%
  {
    const engine = newEngine();
    freezePrice(engine, 5.0);
    const rule = makeRule(engine, 1, {
      side: 'short', trigger_price_e4: 49900, margin_a: 1000, leverage: 10,
    });
    assert.equal(rule.armedSide, 'below');
    freezePrice(engine, 4.989); // 碰到觸發價（4.9900）
    engine.tick(1);
    assert.equal(engine.rules.get(rule.id).status, 'triggered');
    freezePrice(engine, 4.988); // 成交 tick 價格 < 觸發價 → ×0.999
    engine.tick(1);
    const pos = engine.accounts.get(1).openPositions()[0];
    const expected = Math.round(4.988 * (1 - RULE_SLIPPAGE) * 10000);
    assert.equal(pos.entryPriceE4, expected, `成交價應為 next × 0.999（${expected}）`);
  }

  // 賣出 + 價格高於觸發價 → 不加滑價
  {
    const engine = newEngine();
    freezePrice(engine, 5.0);
    const rule = makeRule(engine, 1, {
      side: 'short', trigger_price_e4: 49900, margin_a: 1000, leverage: 10,
    });
    freezePrice(engine, 4.989);
    engine.tick(1);
    freezePrice(engine, 5.001); // 高於觸發價 → 照價成交
    engine.tick(1);
    const pos = engine.accounts.get(1).openPositions()[0];
    assert.equal(pos.entryPriceE4, 50010, '成交價 = 下一 tick 的價格（不加滑價）');
  }
});

// ---------------------------------------------------------------------------
// R4：成交失敗 → 維持 active + last_error + 5 分鐘冷卻
// ---------------------------------------------------------------------------
test('R4. 成交失敗（餘額不足）→ 規則維持 active + last_error；通知每 5 分鐘最多一次', () => {
  const engine = newEngine();
  freezePrice(engine, 5.0);

  const skipped = [];
  engine.rules.onRuleSkipped = (userId, data) => skipped.push(data);

  // 保證金 90,000 A（餘額 100,000 A）→ 建立時可行
  const rule = makeRule(engine, 1, {
    side: 'long', trigger_price_e4: 50100, margin_a: 90000, leverage: 1,
  });

  // 先用掉大部分餘額 → 成交時餘額不足
  const spend = engine.open(1, { side: 'long', marginA: 60000, leverage: 1 });
  assert.ok(spend.ok, '手動開倉應成功');

  freezePrice(engine, 5.011);
  engine.tick(1);
  assert.equal(engine.rules.get(rule.id).status, 'triggered', '已觸發');

  // 下一 tick：成交失敗（餘額不足）
  engine.tick(1);
  const after = engine.rules.get(rule.id);
  assert.equal(after.status, 'active', '失敗後不得停用規則');
  assert.equal(after.lastError, 'insufficient_balance');
  assert.equal(after.pendingTick, null);
  assert.equal(engine.accounts.get(1).openPositions().length, 1, '只有原本的手動部位');

  assert.equal(skipped.length, 1, '第一次失敗要通知');
  assert.equal(skipped[0].reason, 'insufficient_balance');
  assert.equal(skipped[0].rule_id, rule.id);

  // 5 分鐘內重複失敗 → 不再通知（但規則仍會重試）
  engine.tick(10);
  assert.equal(skipped.length, 1, '5 分鐘內不得重複通知');
  assert.equal(engine.rules.get(rule.id).status, 'active');

  // 超過 5 分鐘（300 ticks）→ 再次通知
  engine.tick(300);
  assert.ok(skipped.length >= 2, '超過 5 分鐘可再次通知');
});

// ---------------------------------------------------------------------------
// R5：強平暫停 + 手動恢復
// ---------------------------------------------------------------------------
test('R5. 強平暫停所有啟用中規則；手動重新啟用可恢復', () => {
  const engine = newEngine();
  const rule = makeRule(engine, 1, {
    side: 'long', trigger_price_e4: 51000, margin_a: 1000, leverage: 10,
  });

  // 100× 多單：逆向 1% → 強平
  const opened = engine.open(1, { side: 'long', marginA: 1000, leverage: 100 });
  assert.ok(opened.ok);
  engine.applyShock(-0.01);
  engine.tick(1);

  const paused = engine.rules.get(rule.id);
  assert.equal(paused.status, 'paused', '強平後規則必須暫停');
  assert.equal(paused.pausedReason, 'liquidation');

  // 手動重新啟用
  const resumed = engine.rules.updateRule(1, rule.id, { enabled: true });
  assert.ok(resumed.ok);
  assert.equal(resumed.rule.status, 'active');
  assert.equal(resumed.rule.pausedReason, null);
  assert.equal(resumed.rule.lastError, null);

  // 其他使用者的規則不受影響
  const otherRule = makeRule(engine, 2, {
    side: 'long', trigger_price_e4: 51000, margin_a: 1000, leverage: 10,
  });
  assert.equal(engine.rules.get(otherRule.id).status, 'active');
});

// ---------------------------------------------------------------------------
// R6：離線報告
// ---------------------------------------------------------------------------
test('R6. 離線報告：收入 / 權益高低 / 觸發明細 / 是否強平', () => {
  const engine = newEngine();
  freezePrice(engine, 5.0);
  const rule = makeRule(engine, 1, {
    side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10,
  });

  // 離線 100 個 tick：觸發 + 成交
  freezePrice(engine, 5.011);
  engine.tick(1);
  engine.tick(1); // 成交
  engine.tick(98);

  const report = engine.reports.get(1, { scope: 'live' });
  for (const key of [
    'since_tick', 'until_tick', 'offline_seconds', 'income_milli',
    'equity_start_milli', 'equity_end_milli', 'equity_high_milli', 'equity_low_milli',
    'liquidated', 'triggers',
  ]) {
    assert.ok(key in report, `報告應有 ${key}`);
  }

  assert.equal(report.since_tick, 0);
  assert.equal(report.until_tick, 99); // 100 個 tick → tick id 0..99
  assert.equal(report.offline_seconds, 99);
  assert.equal(report.income_milli, INCOME_MILLI_PER_TICK * 99);
  assert.equal(report.liquidated, false);
  assert.ok(Array.isArray(report.triggers));
  assert.equal(report.triggers.length, 1, '應有一筆「開倉」觸發紀錄');
  const open = report.triggers[0];
  assert.equal(open.kind, 'open');
  assert.equal(open.rule_id, rule.id);
  assert.equal(open.side, 'long');
  assert.equal(open.pnl_milli, null);
  assert.ok(Number.isInteger(open.price_e4) && open.price_e4 > 0);
  assert.ok(Number.isInteger(open.notional_milli) && open.notional_milli > 0);

  // 權益高低點
  assert.ok(report.equity_high_milli >= report.equity_end_milli);
  assert.ok(report.equity_low_milli <= report.equity_end_milli);
  assert.ok(report.equity_end_milli > report.equity_start_milli, '離線期間有收入');
});

test('R6b. 報告會記錄 SL 平倉', () => {
  const engine = newEngine();
  freezePrice(engine, 5.0);
  makeRule(engine, 1, {
    side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10, sl_price_e4: 49800,
  });

  freezePrice(engine, 5.011);
  engine.tick(1);
  engine.tick(1); // 成交（SL 為建立時指定的絕對價位 4.9800）

  // 價格跌破 SL
  freezePrice(engine, 4.9);
  engine.tick(2);

  const report = engine.reports.get(1, { scope: 'live' });
  const kinds = report.triggers.map((t) => t.kind);
  assert.ok(kinds.includes('open'), '應有開倉紀錄');
  assert.ok(kinds.includes('sl'), '應有停損紀錄');
  const sl = report.triggers.find((t) => t.kind === 'sl');
  assert.ok(Number.isInteger(sl.pnl_milli));
  assert.ok(sl.pnl_milli < 0, '停損應為虧損');
  assert.equal(sl.rule_id, engine.rules.listFor(1)[0].id);
});

test('R6c. 第一次 WS 連線不產生離線報告；之後離線重連才有', async () => {
  await withServer(async ({ app, engine }) => {
    freezePrice(engine, 5.0);
    makeRule(engine, 1, { side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10 });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;

    // 新帳號：last_seen_tick 尚未建立
    engine.tick(50);
    const acct = engine.ensureAccount(1);
    assert.equal(acct.lastSeenTick, 0);

    const first = await connectWs(port, 1);
    let second;
    try {
      await first.queue.next(); // snapshot
      assert.equal(acct.lastSeenTick, 49, '第一次連線只建立 last_seen_tick，不產生報告');

      const firstReport = json(await app.inject({ method: 'GET', url: '/api/report?user=1' }));
      assert.equal(firstReport.since_tick, 49);
      assert.equal(firstReport.until_tick, 49);
      assert.equal(firstReport.offline_seconds, 0);
      assert.equal(firstReport.income_milli, 0);

      // 離線 10 秒後重連 → 這次才應有離線報告
      engine.reports.onUserOffline(1);
      engine.tick(10);
      second = await connectWs(port, 1);
      await second.queue.next();
      assert.equal(acct.lastSeenTick, 59);

      const report = json(await app.inject({ method: 'GET', url: '/api/report?user=1' }));
      assert.equal(report.since_tick, 49);
      assert.equal(report.until_tick, 59);
      assert.equal(report.offline_seconds, 10);
      assert.equal(report.income_milli, INCOME_MILLI_PER_TICK * 10);
      assert.ok(report.equity_end_milli > report.equity_start_milli, '離線期間有收入');
      assert.ok(report.equity_high_milli >= report.equity_end_milli);
      assert.ok(report.equity_low_milli <= report.equity_end_milli);
      assert.equal(report.liquidated, false);
      assert.ok(Array.isArray(report.triggers));
    } finally {
      first.ws.close();
      second?.ws.close();
    }
  });
});

// ---------------------------------------------------------------------------
// R7：REST
// ---------------------------------------------------------------------------
test('R7. REST：GET/POST/PATCH/DELETE /api/rules（穩定原因字串）', async () => {
  await withServer(async ({ app, engine }) => {
    freezePrice(engine, 5.0);

    const list0 = json(await app.inject({ method: 'GET', url: '/api/rules?user=1' }));
    assert.equal(list0.max_active, 2);
    assert.deepEqual(list0.rules, []);

    // ---- 穩定原因字串（尚未建立任何規則時） ----
    const badSide = json(await app.inject({
      method: 'POST', url: '/api/rules?user=1',
      payload: { side: 'sideways', trigger_price_e4: 52000, margin_a: 1000, leverage: 10 },
    }));
    assert.equal(badSide.ok, false);
    assert.equal(badSide.reason, 'invalid_side');

    const badLev = json(await app.inject({
      method: 'POST', url: '/api/rules?user=1',
      payload: { side: 'long', trigger_price_e4: 52000, margin_a: 1000, leverage: 7 },
    }));
    assert.equal(badLev.reason, 'invalid_leverage');

    const badMargin = json(await app.inject({
      method: 'POST', url: '/api/rules?user=1',
      payload: { side: 'long', trigger_price_e4: 52000, margin_a: 0, leverage: 10 },
    }));
    assert.equal(badMargin.reason, 'invalid_margin');

    const badTrigger = json(await app.inject({
      method: 'POST', url: '/api/rules?user=1',
      payload: { side: 'long', trigger_price_e4: 0, margin_a: 1000, leverage: 10 },
    }));
    assert.equal(badTrigger.reason, 'invalid_trigger');

    const tooClose = json(await app.inject({
      method: 'POST', url: '/api/rules?user=1',
      payload: { side: 'long', trigger_price_e4: 50000, margin_a: 1000, leverage: 10 },
    }));
    assert.equal(tooClose.reason, 'trigger_too_close');

    const noMoney = json(await app.inject({
      method: 'POST', url: '/api/rules?user=1',
      payload: { side: 'long', trigger_price_e4: 52000, margin_a: 1_000_000, leverage: 1 },
    }));
    assert.equal(noMoney.reason, 'insufficient_margin');

    // ---- 建立 ----
    const created = json(await app.inject({
      method: 'POST',
      url: '/api/rules?user=1',
      payload: { side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10, sl_price_e4: 49800 },
    }));
    assert.equal(created.ok, true);
    const rule = created.rule;
    assert.equal(rule.kind, 'conditional_open');
    assert.equal(rule.status, 'active');
    assert.equal(rule.armed_side, 'above');
    assert.equal(rule.enabled, true);
    assert.equal(rule.sl_price_e4, 49800);
    assert.equal(rule.tp_price_e4, null);
    assert.equal(rule.sl_pct, null);
    assert.equal(rule.tp_pct, null);
    assert.equal(rule.last_error, null);

    // 第 3 條 → max_active_rules
    await app.inject({
      method: 'POST', url: '/api/rules?user=1',
      payload: { side: 'short', trigger_price_e4: 49900, margin_a: 1000, leverage: 10 },
    });
    const third = json(await app.inject({
      method: 'POST', url: '/api/rules?user=1',
      payload: { side: 'long', trigger_price_e4: 52000, margin_a: 1000, leverage: 10 },
    }));
    assert.equal(third.ok, false);
    assert.equal(third.reason, 'max_active_rules');

    // PATCH：停用 / 重新啟用
    const paused = json(await app.inject({
      method: 'PATCH', url: `/api/rules/${rule.id}?user=1`, payload: { enabled: false },
    }));
    assert.equal(paused.ok, true);
    assert.equal(paused.rule.status, 'paused');

    const resumed = json(await app.inject({
      method: 'PATCH', url: `/api/rules/${rule.id}?user=1`, payload: { enabled: true },
    }));
    assert.equal(resumed.ok, true);
    assert.equal(resumed.rule.status, 'active');

    // DELETE → cancelled
    const deleted = json(await app.inject({
      method: 'DELETE', url: `/api/rules/${rule.id}?user=1`,
    }));
    assert.equal(deleted.ok, true);
    assert.equal(deleted.rule.status, 'cancelled');
    assert.equal(deleted.rule.enabled, false);

    // 已取消的規則不得重新啟用
    const reenable = json(await app.inject({
      method: 'PATCH', url: `/api/rules/${rule.id}?user=1`, payload: { enabled: true },
    }));
    assert.equal(reenable.ok, false);
    assert.equal(reenable.reason, 'rule_not_active');

    // 不存在的規則
    const missing = json(await app.inject({
      method: 'PATCH', url: '/api/rules/999?user=1', payload: { enabled: true },
    }));
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'not_found');
  });
});

test('R7b. GET /api/state 的 snapshot 含 rules', async () => {
  await withServer(async ({ app, engine }) => {
    freezePrice(engine, 5.0);
    makeRule(engine, 1, { side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10 });
    const state = json(await app.inject({ method: 'GET', url: '/api/state?user=1' }));
    assert.ok(Array.isArray(state.rules));
    assert.equal(state.rules.length, 1);
    assert.equal(state.rules[0].kind, 'conditional_open');
    // 隱私規則：payload 不得含 type / permanent_share
    assert.ok(!/"type"\s*:/.test(JSON.stringify(state)));
  });
});

// ---------------------------------------------------------------------------
// R8：WebSocket
// ---------------------------------------------------------------------------
test('R8. WS：rule.upsert / rule.delete / rule.updated / rule.triggered', async () => {
  await withServer(async ({ app, engine }) => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    freezePrice(engine, 5.0);
    const { ws, queue } = await connectWs(port, 1);

    try {
      const snapshot = await queue.next();
      assert.equal(snapshot.type, 'snapshot');
      assert.ok(Array.isArray(snapshot.data.rules));

      // rule.upsert → rule.updated（含 request_id）
      ws.send(JSON.stringify({
        type: 'rule.upsert',
        request_id: 'r1',
        data: { side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10 },
      }));
      const updated = await nextOfType(queue, 'rule.updated');
      assert.equal(updated.request_id, 'r1');
      assert.equal(updated.data.status, 'active');
      assert.equal(updated.data.kind, 'conditional_open');
      const ruleId = updated.data.id;

      // 被拒絕 → rule.rejected
      ws.send(JSON.stringify({
        type: 'rule.upsert',
        request_id: 'r2',
        data: { side: 'long', trigger_price_e4: 50000, margin_a: 1000, leverage: 10 },
      }));
      const rejected = await nextOfType(queue, 'rule.rejected');
      assert.equal(rejected.request_id, 'r2');
      assert.equal(rejected.data.reason, 'trigger_too_close');

      // 觸發 → rule.triggered
      freezePrice(engine, 5.011);
      engine.tick(1);
      engine.tick(1);
      const triggered = await nextOfType(queue, 'rule.triggered');
      assert.equal(triggered.data.rule_id, ruleId);
      assert.equal(triggered.data.side, 'long');
      assert.ok(Number.isInteger(triggered.data.fill_price_e4));
      assert.ok(Number.isInteger(triggered.data.position_id));

      // rule.delete → rule.updated（status=cancelled）
      ws.send(JSON.stringify({
        type: 'rule.delete',
        request_id: 'r3',
        data: { rule_id: ruleId },
      }));
      const cancelled = await nextWhere(queue, (m) => m.type === 'rule.updated' && m.request_id === 'r3');
      assert.equal(cancelled.data.status, 'cancelled');
    } finally {
      ws.close();
    }
  });
});

test('R8b. WS：成交失敗 → rule.skipped（每 5 分鐘最多一次）', async () => {
  await withServer(async ({ app, engine }) => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    freezePrice(engine, 5.0);
    const { ws, queue } = await connectWs(port, 1);

    try {
      await queue.next(); // snapshot

      // 保證金 90,000 A → 建立時可行；之後把餘額用掉 → 成交失敗
      ws.send(JSON.stringify({
        type: 'rule.upsert',
        request_id: 'r1',
        data: { side: 'long', trigger_price_e4: 50100, margin_a: 90000, leverage: 1 },
      }));
      await nextOfType(queue, 'rule.updated');

      const spend = engine.open(1, { side: 'long', marginA: 60000, leverage: 1 });
      assert.ok(spend.ok);

      freezePrice(engine, 5.011);
      engine.tick(1);
      engine.tick(1);

      const skipped = await nextOfType(queue, 'rule.skipped');
      assert.equal(skipped.data.reason, 'insufficient_balance');

      // 5 分鐘內不再通知
      engine.tick(10);
      const extra = queue.drain();
      assert.equal(extra.filter((m) => m.type === 'rule.skipped').length, 0, '5 分鐘內不得重複通知');
    } finally {
      ws.close();
    }
  });
});

// ---------------------------------------------------------------------------
// R9：觸發價太近
// ---------------------------------------------------------------------------
test('R9. 觸發價離現價 < 0.05% → trigger_too_close（確認後可建立）', () => {
  const engine = newEngine();
  freezePrice(engine, 5.0); // 50000

  const tooClose = engine.rules.createRule(1, {
    side: 'long', trigger_price_e4: 50010, margin_a: 1000, leverage: 10,
  });
  assert.equal(tooClose.ok, false);
  assert.equal(tooClose.reason, 'trigger_too_close');

  // 差 0.05% 以外 → 可建立
  const ok = engine.rules.createRule(1, {
    side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10,
  });
  assert.ok(ok.ok);

  // 玩家確認後可建立（confirm: true）
  const confirmed = engine.rules.createRule(1, {
    side: 'long', trigger_price_e4: 50010, margin_a: 1000, leverage: 10, confirm: true,
  });
  assert.ok(confirmed.ok, '玩家確認後可建立');
});

// ---------------------------------------------------------------------------
// R9b：規則停損／停利價格制（§7.5）
// ---------------------------------------------------------------------------
test('R9b. 規則 SL/TP 價格制：方向、距離、強平上限、舊 pct 已移除', () => {
  const engine = newEngine();
  freezePrice(engine, 5.0); // 50000

  const base = { side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10 };

  // 做多：SL 必須 < 觸發價、TP 必須 > 觸發價
  assert.equal(engine.rules.createRule(1, { ...base, sl_price_e4: 50200 }).reason, 'sl_wrong_side');
  assert.equal(engine.rules.createRule(1, { ...base, tp_price_e4: 50000 }).reason, 'tp_wrong_side');
  // 距離 < 0.05%
  assert.equal(engine.rules.createRule(1, { ...base, sl_price_e4: 50099 }).reason, 'sl_too_close');
  // 超過強平距離（lev 10：0.098 × 0.9 = 8.82%）
  assert.equal(engine.rules.createRule(1, { ...base, sl_price_e4: 45000 }).reason, 'sl_beyond_liq');

  // 舊百分比欄位 → 明確拒絕（前端需重整）
  assert.equal(engine.rules.createRule(1, { ...base, sl_pct: 0.5 }).reason, 'sl_pct_removed');
  assert.equal(engine.rules.createRule(1, { ...base, tp_pct: 1 }).reason, 'tp_pct_removed');

  // 合法：價格原樣存入（不做任何換算）
  const ok = engine.rules.createRule(1, { ...base, sl_price_e4: 49800, tp_price_e4: 50400 });
  assert.ok(ok.ok, ok.reason);
  assert.equal(ok.rule.slPriceE4, 49800);
  assert.equal(ok.rule.tpPriceE4, 50400);
  assert.equal(ok.rule.params.sl_price_e4, 49800);
  assert.equal(ok.rule.params.tp_price_e4, 50400);

  // 編輯：帶 pct 也拒絕；帶價格可改
  assert.equal(engine.rules.updateRule(1, ok.rule.id, { sl_pct: 0.5 }).reason, 'sl_pct_removed');
  const edited = engine.rules.updateRule(1, ok.rule.id, { sl_price_e4: 49700 });
  assert.ok(edited.ok, edited.reason);
  assert.equal(edited.rule.slPriceE4, 49700);
  assert.equal(edited.rule.tpPriceE4, 50400, '未帶 TP → 沿用原值');
});

// ---------------------------------------------------------------------------
// R9c：手動開倉（REST）價格制契約
// ---------------------------------------------------------------------------
test('R9c. POST /api/open：舊 sl_pct 回 sl_pct_removed、方向錯誤回 sl_wrong_side、價格原樣回傳', async () => {
  await withServer(async ({ app, engine }) => {
    freezePrice(engine, 5.0);

    const post = (payload) => app.inject({ method: 'POST', url: '/api/open?user=1', payload });
    const order = { side: 'long', margin_a: 1000, leverage: 10 };

    assert.equal(json(await post({ ...order, sl_pct: 0.5 })).reason, 'sl_pct_removed');
    assert.equal(json(await post({ ...order, tp_pct: 1 })).reason, 'tp_pct_removed');
    assert.equal(json(await post({ ...order, sl_price_e4: 50500 })).reason, 'sl_wrong_side');
    assert.equal(json(await post({ ...order, sl_price_e4: 49999 })).reason, 'sl_too_close');

    const res = json(await post({ ...order, sl_price_e4: 49800, tp_price_e4: 50400 }));
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.position.sl_price_e4, 49800);
    assert.equal(res.position.tp_price_e4, 50400);
  });
});

// ---------------------------------------------------------------------------
// R11：UI 整合細節（ack / WS data.user / snapshot.rules）
// ---------------------------------------------------------------------------
test('R11. POST /api/report/ack { user } → { ok: true }，last_seen_tick 前移', async () => {
  await withServer(async ({ app, engine }) => {
    engine.tick(30);
    const acct = engine.ensureAccount(1);
    const before = acct.lastSeenTick;

    const res = json(await app.inject({
      method: 'POST',
      url: '/api/report/ack',
      payload: { user: 1 },
    }));
    assert.equal(res.ok, true);
    assert.equal(acct.lastSeenTick, 29, 'ack 後 last_seen_tick = 目前 tick');
    assert.ok(acct.lastSeenTick > before);

    // ack 後的報告區間為空
    const report = json(await app.inject({ method: 'GET', url: '/api/report?user=1' }));
    assert.equal(report.offline_seconds, 0);
  });
});

test('R11b. WS rule.upsert：data 內的 user 欄位被忽略（不因此拒絕）', async () => {
  await withServer(async ({ app, engine }) => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    const { ws, queue } = await connectWs(port, 1);
    try {
      await queue.next(); // snapshot
      ws.send(JSON.stringify({
        type: 'rule.upsert',
        request_id: 'u1',
        data: { user: 1, side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10 },
      }));
      const updated = await nextOfType(queue, 'rule.updated');
      assert.equal(updated.request_id, 'u1');
      assert.equal(updated.data.status, 'active');
      assert.equal(updated.data.kind, 'conditional_open');

      // 頂層 user 不符仍要拒絕
      ws.send(JSON.stringify({
        type: 'rule.upsert',
        request_id: 'u2',
        user: 2,
        data: { side: 'long', trigger_price_e4: 52000, margin_a: 1000, leverage: 10 },
      }));
      const rejected = await nextOfType(queue, 'rule.rejected');
      assert.equal(rejected.request_id, 'u2');
      assert.equal(rejected.data.reason, 'user_mismatch');
    } finally {
      ws.close();
    }
  });
});

// ---------------------------------------------------------------------------
// R10：DB（schema / 遷移 / 重啟還原 / ledger source）
// ---------------------------------------------------------------------------
let sqliteAvailable = true;
try {
  await import('better-sqlite3');
} catch {
  sqliteAvailable = false;
}

test('R10. schema：M3 新增欄位與 rule_events 表（§6.2 v0.25 欄位不動）', { skip: !sqliteAvailable && 'better-sqlite3 不可用' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxsim-m3-db-'));
  const dbPath = join(dir, 'fxsim.db');
  try {
    const store = await openSqliteStore(dbPath);
    const db = store.db;
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name);

    // §6.2 v0.25 既有欄位仍在
    assert.ok(cols('rules').includes('params_json'));
    assert.ok(cols('rules').includes('enabled'));
    assert.ok(cols('rules').includes('created_tick'));
    assert.ok(cols('rules').includes('triggered_tick'));
    assert.ok(cols('accounts').includes('last_settled_tick'));
    assert.ok(cols('positions').includes('fee_remainder_micro'));

    // M3 新增欄位
    for (const col of ['status', 'armed_side', 'last_error', 'paused_reason', 'last_notified_tick', 'sl_pct', 'tp_pct', 'sl_price_e4', 'tp_price_e4']) {
      assert.ok(cols('rules').includes(col), `rules 應有 ${col}`);
    }
    for (const col of ['last_seen_tick', 'equity_high_milli', 'equity_low_milli']) {
      assert.ok(cols('accounts').includes(col), `accounts 應有 ${col}`);
    }
    assert.ok(cols('positions').includes('rule_id'), 'positions 應有 rule_id');
    assert.ok(cols('ledger').includes('source'), 'ledger 應有 source');
    assert.ok(tables.includes('rule_events'), '應有 rule_events 表');

    store.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
});

test('R10b. 遷移：既有的 M2 schema 開啟後會補上 M3 欄位（線上 DB 不需重建）', { skip: !sqliteAvailable && 'better-sqlite3 不可用' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxsim-m3-mig-'));
  const dbPath = join(dir, 'fxsim.db');
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath);
    // M2（§6.2 v0.25）的舊 schema
    db.exec(`
      CREATE TABLE accounts (user_id INTEGER PRIMARY KEY, balance_milli INTEGER NOT NULL DEFAULT 0,
        settled_tick_id INTEGER NOT NULL DEFAULT 0, last_settled_tick INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE rules (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
        params_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
        created_tick INTEGER NOT NULL DEFAULT 0, triggered_tick INTEGER);
      CREATE TABLE positions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, side TEXT NOT NULL,
        notional_milli INTEGER NOT NULL, leverage INTEGER NOT NULL, entry_price_e4 INTEGER NOT NULL,
        margin_milli INTEGER NOT NULL, liq_price_e4 INTEGER NOT NULL, sl_price_e4 INTEGER, tp_price_e4 INTEGER,
        fee_remainder_micro INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
        opened_tick INTEGER NOT NULL DEFAULT 0, closed_tick INTEGER, close_price_e4 INTEGER,
        pnl_milli INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE ledger (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, delta_milli INTEGER NOT NULL,
        reason TEXT NOT NULL, tick_id INTEGER NOT NULL DEFAULT 0);
    `);
    db.close();

    const store = await openSqliteStore(dbPath);
    const cols = (table) => store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(cols('rules').includes('status'), 'rules 應補上 status');
    assert.ok(cols('rules').includes('armed_side'), 'rules 應補上 armed_side');
    assert.ok(cols('accounts').includes('last_seen_tick'), 'accounts 應補上 last_seen_tick');
    assert.ok(cols('positions').includes('rule_id'), 'positions 應補上 rule_id');
    assert.ok(cols('ledger').includes('source'), 'ledger 應補上 source');
    store.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
});

test('R10c. 重啟後規則與規則事件都還在；規則開倉的 ledger source=rule', { skip: !sqliteAvailable && 'better-sqlite3 不可用' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxsim-m3-restart-'));
  const dbPath = join(dir, 'fxsim.db');
  let store = null;
  try {
    // ---- 第一次開機 ----
    store = await openSqliteStore(dbPath);
    const e1 = new Engine({ seed: 42, store });
    e1.load();
    e1.init();
    freezePrice(e1, 5.0);
    const rule = makeRule(e1, 1, { side: 'long', trigger_price_e4: 50100, margin_a: 1000, leverage: 10 });
    freezePrice(e1, 5.011);
    e1.tick(1);
    e1.tick(1); // 成交
    e1.persist();
    const ruleId = rule.id;
    store.close();
    store = null;

    // ---- 重開 ----
    store = await openSqliteStore(dbPath);
    const e2 = new Engine({ seed: 42, store });
    e2.load();
    e2.init();
    const restored = e2.rules.get(ruleId);
    assert.ok(restored, '重啟後規則必須還在');
    assert.equal(restored.status, 'triggered');
    assert.equal(restored.triggerPriceE4, 50100);
    assert.equal(restored.armedSide, 'above');

    const events = store.loadRuleEvents(1, -1, 1e9);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'open');
    assert.equal(events[0].ruleId, ruleId);

    // ledger：規則開倉的來源標記為 rule
    const ledger = store.loadLedger(100);
    const ruleRows = ledger.filter((l) => l.source === 'rule');
    assert.ok(ruleRows.length > 0, '規則開倉的 ledger 應標記 source=rule');
  } finally {
    store?.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
});
