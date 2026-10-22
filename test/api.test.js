/**
 * M2 API / WebSocket 驗收（contract「M2 acceptance」）。
 *
 *   - GET  /healthz
 *   - GET  /api/state   （起始餘額 100,000 A）
 *   - GET  /api/config
 *   - POST /api/open    （1,000 A × 10 → 10,000 A 名目）
 *   - POST /api/close   （立刻平倉 → 負損益）
 *   - GET  /api/candles （最舊 → 最新，上限 600）
 *   - GET  /api/events  （最新 → 最舊；無 type / permanent_share）
 *   - WS   /ws?user=1   （snapshot → tick；order.open → order.filled）
 *
 * 每個測試都用**全新的暫存 DB**；tick 迴圈不啟動（`live: false`），
 * 需要時間推進時由測試手動呼叫 `engine.tick()`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

import { buildServer } from '../src/server.js';

const INITIAL_BALANCE_MILLI = 100_000_000; // 100,000 A

/** 每個測試都用**全新的暫存 DB** */
async function withServer(fn, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fxsim-m2-'));
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

/** 簡易訊息佇列（WS 測試用） */
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
        const timer = setTimeout(
          () => reject(new Error('等待 WS 訊息逾時')),
          timeoutMs,
        );
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    },
  };
}

async function connectWs(port, userId = 1) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?user=${userId}`);
  // 先掛 message 監聽器再等 open：伺服器在 handshake 完成後立刻送 snapshot，
  // 若等到 open 才掛會漏掉第一則訊息。
  const queue = makeQueue(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, queue };
}

// ---------------------------------------------------------------------------
test('GET /healthz 回傳 ok / tick_id / uptime_s', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.ok, true);
    assert.equal(typeof body.tick_id, 'number');
    assert.ok(Number.isInteger(body.tick_id));
    assert.equal(typeof body.uptime_s, 'number');
    assert.ok(body.uptime_s >= 0);
  });
});

test('GET /api/state：起始餘額 100,000 A、market / account 欄位齊全', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/state?user=1' });
    assert.equal(res.statusCode, 200);
    const body = json(res);

    assert.equal(typeof body.server_time, 'string');
    assert.ok(!Number.isNaN(Date.parse(body.server_time)));
    assert.equal(typeof body.tick_id, 'number');

    assert.equal(body.account.balance_milli, INITIAL_BALANCE_MILLI);
    assert.equal(body.account.available_milli, INITIAL_BALANCE_MILLI);
    assert.equal(body.account.equity_milli, INITIAL_BALANCE_MILLI);
    assert.equal(body.account.margin_milli, 0);
    assert.equal(typeof body.account.settled_tick_id, 'number');

    assert.ok(body.market.price_e4 > 0);
    assert.ok(body.market.base_price_e4 > 0);
    assert.equal(typeof body.market.impact, 'number');
    assert.equal(body.market.net_notional_milli, 0);
    assert.equal(body.market.L_milli, 3_000_000_000);

    assert.deepEqual(body.positions, []);
    assert.deepEqual(body.candles, []);
    assert.deepEqual(body.events, []);
  });
});

test('GET /api/config：槓桿、最小保證金、費率', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(res.statusCode, 200);
    const body = json(res);

    assert.deepEqual(body.leverage, [1, 2, 5, 10, 20, 50, 100]);
    assert.equal(body.default_leverage, 10);
    assert.equal(body.max_positions, 5);
    assert.equal(body.min_notional_a, 10_000);
    assert.equal(body.spread_per_side, 0.0002);
    assert.equal(body.fee_long_annual, 0.026);
    assert.equal(body.fee_short_annual, 0.009);
    assert.equal(body.maintenance_rate, 0.002);

    assert.deepEqual(body.min_margin_a, {
      1: 10_000, 2: 5_000, 5: 2_000, 10: 1_000, 20: 500, 50: 200, 100: 100,
    });
  });
});

test('POST /api/open：1,000 A × 10 → 10,000 A 名目（整數 milli-A / e4）', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/open?user=1',
      payload: { side: 'long', margin_a: 1000, leverage: 10 },
    });
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.ok, true);

    const p = body.position;
    assert.equal(p.side, 'long');
    assert.equal(p.leverage, 10);
    assert.equal(p.notional_milli, 10_000_000); // 10,000 A
    assert.equal(p.margin_milli, 1_000_000); // 1,000 A
    assert.equal(p.status, 'open');
    assert.ok(Number.isInteger(p.entry_price_e4) && p.entry_price_e4 > 0);
    assert.ok(Number.isInteger(p.liq_price_e4) && p.liq_price_e4 > 0);
    assert.equal(p.sl_price_e4, null);
    assert.equal(p.tp_price_e4, null);
    assert.ok(Number.isInteger(p.pnl_milli));

    assert.equal(body.fill.notional_milli, 10_000_000);
    assert.equal(body.fill.margin_milli, 1_000_000);
    assert.equal(body.fill.price_e4, p.entry_price_e4);

    // 持倉出現在 state，且可用餘額扣掉保證金
    const state = json(await app.inject({ method: 'GET', url: '/api/state?user=1' }));
    assert.equal(state.positions.length, 1);
    assert.equal(state.positions[0].id, p.id);
    assert.equal(state.account.margin_milli, 1_000_000);
    assert.equal(state.account.balance_milli, INITIAL_BALANCE_MILLI - 1_000_000);
    // 其他使用者不受影響
    const other = json(await app.inject({ method: 'GET', url: '/api/state?user=2' }));
    assert.equal(other.account.balance_milli, INITIAL_BALANCE_MILLI);
    assert.equal(other.positions.length, 0);
  });
});

test('POST /api/close：立刻平倉 → 負損益', async () => {
  await withServer(async ({ app }) => {
    const open = json(
      await app.inject({
        method: 'POST',
        url: '/api/open?user=1',
        payload: { side: 'long', margin_a: 1000, leverage: 10 },
      }),
    );
    assert.equal(open.ok, true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/close?user=1',
      payload: { position_id: open.position.id },
    });
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.ok, true);
    assert.ok(Number.isInteger(body.exit_price_e4) && body.exit_price_e4 > 0);
    assert.ok(Number.isInteger(body.pnl_milli));
    assert.ok(body.pnl_milli < 0, `立刻平倉損益應為負（實際 ${body.pnl_milli}）`);

    // 平倉後持倉清空、保證金退回
    const state = json(await app.inject({ method: 'GET', url: '/api/state?user=1' }));
    assert.equal(state.positions.length, 0);
    assert.equal(state.account.margin_milli, 0);
    assert.equal(state.account.balance_milli, INITIAL_BALANCE_MILLI + body.pnl_milli);
  });
});

test('POST /api/open 拒絕原因為穩定機器字串', async () => {
  await withServer(async ({ app }) => {
    const badSide = json(
      await app.inject({
        method: 'POST',
        url: '/api/open?user=1',
        payload: { side: 'sideways', margin_a: 1000, leverage: 10 },
      }),
    );
    assert.equal(badSide.ok, false);
    assert.equal(badSide.reason, 'invalid_side');

    const badLev = json(
      await app.inject({
        method: 'POST',
        url: '/api/open?user=1',
        payload: { side: 'long', margin_a: 1000, leverage: 7 },
      }),
    );
    assert.equal(badLev.ok, false);
    assert.equal(badLev.reason, 'invalid_leverage');

    // 餘額不足：1,000,000 A 保證金 > 100,000 A 餘額
    const noMoney = json(
      await app.inject({
        method: 'POST',
        url: '/api/open?user=1',
        payload: { side: 'long', margin_a: 1_000_000, leverage: 1 },
      }),
    );
    assert.equal(noMoney.ok, false);
    assert.equal(noMoney.reason, 'insufficient_balance');

    // 平倉不存在的持倉
    const notFound = json(
      await app.inject({
        method: 'POST',
        url: '/api/close?user=1',
        payload: { position_id: 999 },
      }),
    );
    assert.equal(notFound.ok, false);
    assert.equal(notFound.reason, 'not_found');
  });
});

test('GET /api/candles：最舊 → 最新，上限 600', async () => {
  await withServer(async ({ app, engine }) => {
    engine.tick(180); // 3 分鐘 → 3 根 1 分 K

    const res = await app.inject({ method: 'GET', url: '/api/candles?limit=60' });
    assert.equal(res.statusCode, 200);
    const candles = json(res);
    assert.equal(candles.length, 3);
    for (let i = 1; i < candles.length; i++) {
      assert.ok(candles[i].minute_id > candles[i - 1].minute_id, 'K 線必須最舊 → 最新');
    }
    const c = candles[0];
    for (const key of [
      'minute_id', 'started_at', 'open_e4', 'high_e4', 'low_e4', 'close_e4',
      'base_close_e4', 'net_notional_milli', 'volume_notional_milli',
    ]) {
      assert.ok(key in c, `K 線應有 ${key}`);
    }
    assert.ok(c.high_e4 >= c.low_e4);

    // limit 上限 600
    const capped = json(await app.inject({ method: 'GET', url: '/api/candles?limit=9999' }));
    assert.ok(capped.length <= 600);
  });
});

test('GET /api/events：最新 → 最舊，且不含 type / permanent_share', async () => {
  await withServer(async ({ app, engine }) => {
    engine.market.fireEvent('news', engine.ticksExecuted);
    engine.market.fireEvent('major', engine.ticksExecuted);
    engine.market.fireEvent('structural', engine.ticksExecuted);

    const res = await app.inject({ method: 'GET', url: '/api/events?limit=100' });
    assert.equal(res.statusCode, 200);
    const events = json(res);
    assert.equal(events.length, 3);
    // 最新 → 最舊
    assert.ok(events[0].id > events[1].id);
    assert.ok(events[1].id > events[2].id);
    for (const ev of events) {
      assert.deepEqual(
        Object.keys(ev).sort(),
        ['headline', 'id', 'impact_jump', 'tick_id'],
        '事件 payload 只能有這四個欄位',
      );
      assert.equal(typeof ev.headline, 'string');
      assert.equal(typeof ev.impact_jump, 'number');
    }
    // 隱私：整段回應文字不得出現 type / permanent_share
    assert.ok(!res.body.includes('permanent_share'));
    assert.ok(!/"type"/.test(res.body));
  });
});

test('任何 API / WS payload 都不得出現 type / permanent_share', async () => {
  await withServer(async ({ app, engine, hub }) => {
    engine.market.fireEvent('news', engine.ticksExecuted);
    engine.open(1, { side: 'long', marginA: 1000, leverage: 10 });

    const bodies = [
      (await app.inject({ method: 'GET', url: '/api/state?user=1' })).body,
      (await app.inject({ method: 'GET', url: '/api/events?limit=100' })).body,
      (await app.inject({ method: 'GET', url: '/api/candles?limit=60' })).body,
    ];
    for (const b of bodies) {
      assert.ok(!b.includes('permanent_share'), 'payload 不得含 permanent_share');
      assert.ok(!/"type"\s*:/.test(b), 'payload 不得含 type 欄位');
    }
    // tick payload
    const tick = JSON.stringify({
      type: 'tick',
      data: JSON.parse((await app.inject({ method: 'GET', url: '/api/state?user=1' })).body),
    });
    assert.ok(!tick.includes('permanent_share'));
    void hub;
  });
});

test('WS：連線立即收到 snapshot，之後每秒收到 tick', async () => {
  await withServer(async ({ app, hub }) => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    const { ws, queue } = await connectWs(port, 1);

    try {
      const snapshot = await queue.next();
      assert.equal(snapshot.type, 'snapshot');
      assert.equal(snapshot.data.account.balance_milli, INITIAL_BALANCE_MILLI);
      assert.equal(snapshot.data.positions.length, 0);
      assert.equal(typeof snapshot.data.market.price_e4, 'number');
      assert.equal(typeof snapshot.data.tick_id, 'number');

      // 手動觸發一次 tick 廣播（測試不跑真實迴圈）
      hub.broadcastTick();
      const tick = await queue.next();
      assert.equal(tick.type, 'tick');
      assert.equal(typeof tick.data.tick_id, 'number');
      assert.equal(typeof tick.data.market.price_e4, 'number');
      assert.equal(tick.data.account.balance_milli, INITIAL_BALANCE_MILLI);
      assert.ok(Array.isArray(tick.data.positions));

      // ping → pong
      ws.send(JSON.stringify({ type: 'ping' }));
      const pong = await queue.next();
      assert.equal(pong.type, 'pong');
    } finally {
      ws.close();
    }
  });
});

test('WS：order.open → order.filled（回傳 request_id）；order.close 亦同', async () => {
  await withServer(async ({ app }) => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    const { ws, queue } = await connectWs(port, 1);

    try {
      await queue.next(); // snapshot

      ws.send(
        JSON.stringify({
          type: 'order.open',
          request_id: 'abc',
          data: { side: 'long', margin_a: 1000, leverage: 10 },
        }),
      );
      const filled = await queue.next();
      assert.equal(filled.type, 'order.filled');
      assert.equal(filled.request_id, 'abc');
      assert.equal(filled.data.side, 'long');
      assert.equal(filled.data.position.notional_milli, 10_000_000);
      assert.equal(filled.data.fill.margin_milli, 1_000_000);
      assert.ok(Number.isInteger(filled.data.position.pnl_milli));

      const positionId = filled.data.position.id;
      ws.send(
        JSON.stringify({
          type: 'order.close',
          request_id: 'def',
          data: { position_id: positionId },
        }),
      );
      const closed = await queue.next();
      assert.equal(closed.type, 'order.filled');
      assert.equal(closed.request_id, 'def');
      assert.ok(closed.data.pnl_milli < 0, '立刻平倉損益應為負');

      // 被拒絕時回 order.rejected + 穩定原因
      ws.send(
        JSON.stringify({
          type: 'order.open',
          request_id: 'ghi',
          data: { side: 'long', margin_a: 1000, leverage: 7 },
        }),
      );
      const rejected = await queue.next();
      assert.equal(rejected.type, 'order.rejected');
      assert.equal(rejected.request_id, 'ghi');
      assert.equal(rejected.data.reason, 'invalid_leverage');
    } finally {
      ws.close();
    }
  });
});

test('WS：身分不符的訂單一律拒絕（user_mismatch）', async () => {
  await withServer(async ({ app }) => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    const { ws, queue } = await connectWs(port, 1);

    try {
      await queue.next(); // snapshot
      ws.send(
        JSON.stringify({
          type: 'order.open',
          request_id: 'x',
          user: 2,
          data: { side: 'long', margin_a: 1000, leverage: 10 },
        }),
      );
      const rejected = await queue.next();
      assert.equal(rejected.type, 'order.rejected');
      assert.equal(rejected.data.reason, 'user_mismatch');
    } finally {
      ws.close();
    }
  });
});

test('靜態頁：GET / 回傳 public/index.html（無外部 CDN）', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    // doctype 大小寫不拘（HTML 大小寫不敏感；前端可能寫成 <!DOCTYPE html>）
    assert.ok(res.body.toLowerCase().includes('<!doctype html>'));
    // 不得從外部網域載入資源（data: URI 內的 SVG namespace 不算外部引用）
    const external = res.body.match(
      /(?:src|href)\s*=\s*["']https?:\/\/[^"']+|url\(\s*["']?https?:\/\/[^"')]+/gi,
    );
    assert.equal(external, null, '不得引用外部 CDN');
  });
});

test('WS：真實 tick 迴圈會定期推送 tick（drift-corrected）', async () => {
  await withServer(async ({ app }) => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    const { ws, queue } = await connectWs(port, 1);
    try {
      const snapshot = await queue.next();
      assert.equal(snapshot.type, 'snapshot');
      const tick = await queue.next();
      assert.equal(tick.type, 'tick');
      assert.ok(Number.isInteger(tick.data.tick_id));
      // 迴圈會持續推進（第二秒的 tick_id 必須比第一個大）
      const tick2 = await queue.next();
      assert.equal(tick2.type, 'tick');
      assert.ok(tick2.data.tick_id > tick.data.tick_id, 'tick_id 必須遞增');
    } finally {
      ws.close();
    }
  }, { tickMs: 50, live: true });
});

test('WS：新事件廣播 event（且不含 type / permanent_share）', async () => {
  await withServer(async ({ app, engine }) => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    const { ws, queue } = await connectWs(port, 1);
    try {
      await queue.next(); // snapshot
      engine.market.fireEvent('news', engine.ticksExecuted);

      const ev = await queue.next();
      assert.equal(ev.type, 'event');
      assert.deepEqual(
        Object.keys(ev.data).sort(),
        ['headline', 'id', 'impact_jump', 'tick_id'],
      );
      assert.ok(typeof ev.data.headline === 'string' && ev.data.headline.length > 0);
    } finally {
      ws.close();
    }
  });
});

test('WS：強平只通知受影響的使用者', async () => {
  await withServer(async ({ app, engine }) => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    const u1 = await connectWs(port, 1);
    const u2 = await connectWs(port, 2);
    try {
      await u1.queue.next(); // snapshot（user 1）
      await u2.queue.next(); // snapshot（user 2）

      // 100× 多單：逆向 1% > 強平距離 0.8% → 下一個 tick 觸發強平
      const opened = engine.open(1, { side: 'long', marginA: 1000, leverage: 100 });
      assert.ok(opened.ok, '開倉失敗');
      engine.applyShock(-0.01);
      engine.tick(1);

      const liq = await u1.queue.next();
      assert.equal(liq.type, 'liquidation');
      assert.equal(liq.data.position_id, opened.position.id);
      assert.ok(Number.isInteger(liq.data.price_e4) && liq.data.price_e4 > 0);
      assert.ok(liq.data.pnl_milli < 0, '強平損益應為負');

      // user 2 不應收到強平通知
      let otherGot = null;
      const deadline = Date.now() + 300;
      while (Date.now() < deadline && !otherGot) {
        otherGot = await Promise.race([
          u2.queue.next(250).catch(() => null),
          new Promise((r) => setTimeout(() => r(null), 250)),
        ]);
      }
      assert.equal(otherGot, null, '強平只應通知受影響的使用者');
    } finally {
      u1.ws.close();
      u2.ws.close();
    }
  });
});
