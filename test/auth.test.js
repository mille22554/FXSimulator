/**
 * M3 認證驗收（spec §6.1 / §10「登入與註冊」、m3-auth.md §8）。
 *
 *   - 未登入 `GET /api/state` → 401（DEV_AUTH=0）
 *   - 未登入 `GET /api/me`   → 401
 *   - `DEV_AUTH=1` → `GET /api/state?user=1` → 200（既有 51 個測試的行為）
 *   - WS 未登入 → close(1008)
 *   - better-auth migration 冪等 + `ba_*` 資料表存在
 *   - `users.ba_user_id` 欄位與 unique index 存在
 *   - 首次 Google 登入 → 建立本地 `users` + `accounts`（100,000 A）；重複登入不重複發放
 *   - `users.disabled = 1` → 403
 *   - `/api/auth/get-session` 無 cookie → null
 *
 * ⚠️ **不真的打 Google**：session 相關的測試用 stub（假的 `auth.api.getSession`），
 *    或直接插入 `ba_user` / `ba_account` 列模擬「已登入」狀態。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';
import { getMigrations } from 'better-auth/db/migration';

import { buildServer } from '../src/server.js';
import { initAuth, authOptions } from '../src/auth.js';
import { resolveLocalUser, resolveUserId, devAuthEnabled } from '../src/identity.js';
import { openSqliteStore } from '../src/db.js';

const INITIAL_BALANCE_MILLI = 100_000_000; // 100,000 A

/** 每個測試都用全新的暫存 DB */
async function withServer(fn, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fxsim-auth-'));
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

/** 暫時切換 DEV_AUTH（測試結束後還原） */
async function withDevAuth(value, fn) {
  const prev = process.env.DEV_AUTH;
  if (value === null || value === undefined) delete process.env.DEV_AUTH;
  else process.env.DEV_AUTH = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DEV_AUTH;
    else process.env.DEV_AUTH = prev;
  }
}

function json(res) {
  return JSON.parse(res.body);
}

/** 在 DB 塞一組「已登入的 Google 帳號」（ba_user + ba_account） */
function seedGoogleIdentity(store, { baUserId, googleSub, email, name, image }) {
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO ba_user (id, name, email, emailVerified, image, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(baUserId, name, email, image, now, now);
  store.db
    .prepare(
      `INSERT INTO ba_account (id, accountId, providerId, userId, createdAt, updatedAt)
       VALUES (?, ?, 'google', ?, ?, ?)`,
    )
    .run(`acct-${baUserId}`, googleSub, baUserId, now, now);
  return { id: baUserId, email, name, image };
}

// ---------------------------------------------------------------------------
test('未登入 GET /api/state → 401（DEV_AUTH=0）', async () => {
  await withDevAuth('0', () =>
    withServer(async ({ app }) => {
      const res = await app.inject({ method: 'GET', url: '/api/state?user=1' });
      assert.equal(res.statusCode, 401);
      assert.equal(json(res).error, 'unauthorized');
    }),
  );
});

test('未登入 GET /api/me → 401', async () => {
  await withDevAuth('0', () =>
    withServer(async ({ app }) => {
      const res = await app.inject({ method: 'GET', url: '/api/me' });
      assert.equal(res.statusCode, 401);
      const body = json(res);
      assert.equal(body.error, 'unauthorized');
      assert.equal(body.user, undefined);
    }),
  );
});

test('未登入 GET /api/open → 401（DEV_AUTH=0）', async () => {
  await withDevAuth('0', () =>
    withServer(async ({ app }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/open?user=1',
        payload: { side: 'long', margin_a: 1000, leverage: 10 },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(json(res).error, 'unauthorized');
    }),
  );
});

test('DEV_AUTH=1 → GET /api/state?user=1 → 200（既有測試行為保留）', async () => {
  await withDevAuth('1', () =>
    withServer(async ({ app }) => {
      const res = await app.inject({ method: 'GET', url: '/api/state?user=1' });
      assert.equal(res.statusCode, 200);
      const body = json(res);
      assert.equal(body.account.balance_milli, INITIAL_BALANCE_MILLI);
      assert.deepEqual(body.positions, []);
    }),
  );
});

test('DEV_AUTH=1 → GET /api/me 回 dev_auth: true', async () => {
  await withDevAuth('1', () =>
    withServer(async ({ app }) => {
      const res = await app.inject({ method: 'GET', url: '/api/me' });
      assert.equal(res.statusCode, 200);
      const body = json(res);
      assert.equal(body.dev_auth, true);
      assert.equal(body.user.id, 1);
      assert.ok('role' in body.user);
    }),
  );
});

test('devAuthEnabled：production 一律 false、DEV_AUTH=0 → false', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDev = process.env.DEV_AUTH;
  try {
    process.env.NODE_ENV = 'production';
    process.env.DEV_AUTH = '1';
    assert.equal(devAuthEnabled(), false, 'production 不得開啟 DEV_AUTH');
    process.env.NODE_ENV = 'test';
    process.env.DEV_AUTH = '0';
    assert.equal(devAuthEnabled(), false);
    process.env.DEV_AUTH = '1';
    assert.equal(devAuthEnabled(), true);
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevDev === undefined) delete process.env.DEV_AUTH;
    else process.env.DEV_AUTH = prevDev;
  }
});

test('WS：未登入（DEV_AUTH=0）→ close(1008)', async () => {
  await withDevAuth('0', () =>
    withServer(async ({ app }) => {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = app.server.address().port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 WS close 逾時')), 5000);
        ws.on('close', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
        ws.on('error', () => {
          /* 伺服器直接關閉 → 可能有 ECONNRESET，忽略 */
        });
      });
      assert.equal(code, 1008);
    }),
  );
});

test('WS：DEV_AUTH=1 → 連線成功並收到 snapshot', async () => {
  await withDevAuth('1', () =>
    withServer(async ({ app }) => {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = app.server.address().port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?user=1`);
      const snapshot = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 snapshot 逾時')), 5000);
        ws.on('message', (data) => {
          clearTimeout(timer);
          resolve(JSON.parse(data.toString()));
        });
        ws.on('error', reject);
      });
      assert.equal(snapshot.type, 'snapshot');
      assert.equal(snapshot.data.account.balance_milli, INITIAL_BALANCE_MILLI);
      ws.close();
    }),
  );
});

test('better-auth migration 冪等 + ba_* 資料表存在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxsim-auth-mig-'));
  const dbPath = join(dir, 'fxsim.db');
  let store = null;
  try {
    store = await openSqliteStore(dbPath);

    // 先用未解析的 options 取得計畫並建立資料表（避免在缺表時初始化 auth 實例）
    const plan = await getMigrations(authOptions(store.db));
    assert.deepEqual(
      plan.toBeCreated.map((t) => t.table).sort(),
      ['ba_account', 'ba_session', 'ba_user', 'ba_verification'],
      '第一次應建立四張 ba_* 表',
    );
    await plan.runMigrations();

    // 用 auth.options 再檢查一次 → 冪等（沒有待建立 / 待新增）
    const auth = initAuth(store.db);
    const second = await getMigrations(auth.options);
    assert.equal(second.toBeCreated.length, 0, 'migration 必須冪等（不可重複建表）');
    assert.equal(second.toBeAdded.length, 0, 'migration 必須冪等（不可重複加欄位）');
    await second.runMigrations();

    const tables = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ba_%' ORDER BY name`)
      .all()
      .map((r) => r.name);
    assert.deepEqual(tables, ['ba_account', 'ba_session', 'ba_user', 'ba_verification']);

    // users.ba_user_id 欄位 + unique index
    const cols = store.db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
    assert.ok(cols.includes('ba_user_id'), 'users 必須有 ba_user_id 欄位');
    const idx = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_ba_user_id'`)
      .all();
    assert.equal(idx.length, 1, 'users.ba_user_id 必須有 unique index');
  } finally {
    store?.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* ignore cleanup error */
    }
  }
});

test('users.ba_user_id 欄位與 unique index（既有 DB 也要補上）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxsim-auth-col-'));
  const dbPath = join(dir, 'fxsim.db');
  let store = null;
  try {
    store = await openSqliteStore(dbPath);
    const cols = store.db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
    assert.ok(cols.includes('ba_user_id'));
    const idx = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_ba_user_id'`)
      .all();
    assert.equal(idx.length, 1);
  } finally {
    store?.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* ignore cleanup error */
    }
  }
});

test('首次 Google 登入 → 建立本地 users + accounts（100,000 A）；再次登入不重複發放', async () => {
  await withServer(async ({ store, engine }) => {
    const googleSub = 'google-sub-0001';
    const baUserId = 'ba-user-uuid-0001';
    const user = seedGoogleIdentity(store, {
      baUserId,
      googleSub,
      email: 'player1@example.com',
      name: '玩家一',
      image: 'https://example.com/a1.png',
    });

    const session = { session: { id: 'sess-1' }, user };
    const ctx = { store, engine };

    const row = await resolveLocalUser(session, ctx);
    assert.ok(row, '必須建立本地 users 列');
    assert.ok(Number.isInteger(row.id) && row.id > 0, '本地 users.id 必須是整數');
    assert.equal(row.ba_user_id, baUserId, '必須寫回 users.ba_user_id');
    assert.equal(row.google_sub, googleSub, 'Google sub 必須是唯一鍵');
    assert.equal(row.email, 'player1@example.com');
    assert.equal(row.display_name, '玩家一');
    assert.equal(row.avatar_url, 'https://example.com/a1.png');
    assert.equal(row.role, 'player');
    assert.equal(row.disabled, 0);

    // accounts：100,000 A = 100,000,000 milli-A
    const acct = store.db.prepare(`SELECT * FROM accounts WHERE user_id = ?`).get(row.id);
    assert.ok(acct, '必須建立 accounts 列');
    assert.equal(acct.balance_milli, INITIAL_BALANCE_MILLI);

    // 第二次登入 → 不得重複建立、不得重複發放
    const row2 = await resolveLocalUser(session, ctx);
    assert.equal(row2.id, row.id, '同一個 Google 帳號只能有一個角色');
    assert.equal(
      store.db.prepare(`SELECT COUNT(*) AS c FROM users WHERE ba_user_id = ?`).get(baUserId).c,
      1,
    );
    assert.equal(
      store.db.prepare(`SELECT COUNT(*) AS c FROM accounts WHERE user_id = ?`).get(row.id).c,
      1,
    );
    const acct2 = store.db.prepare(`SELECT * FROM accounts WHERE user_id = ?`).get(row.id);
    assert.equal(acct2.balance_milli, INITIAL_BALANCE_MILLI, '不得重複發放起始資金');
  });
});

test('既有本地帳號（google_sub）→ 登入時被連結，不另建角色', async () => {
  await withServer(async ({ store, engine }) => {
    const googleSub = 'google-sub-0002';
    // 先手動建立一個只有 google_sub 的本地帳號
    store.db
      .prepare(
        `INSERT INTO users (google_sub, email, email_verified, display_name, disabled, role, created_at)
         VALUES (?, ?, 1, '舊角色', 0, 'player', ?)`,
      )
      .run(googleSub, 'old@example.com', new Date().toISOString());
    const existing = store.db.prepare(`SELECT * FROM users WHERE google_sub = ?`).get(googleSub);

    const baUserId = 'ba-user-uuid-0002';
    const user = seedGoogleIdentity(store, {
      baUserId,
      googleSub,
      email: 'old@example.com',
      name: '舊角色',
      image: null,
    });

    const row = await resolveLocalUser({ user }, { store, engine });
    assert.equal(row.id, existing.id, '應沿用既有本地角色');
    assert.equal(row.ba_user_id, baUserId, '應寫回 ba_user_id');
    assert.equal(
      store.db.prepare(`SELECT COUNT(*) AS c FROM users WHERE google_sub = ?`).get(googleSub).c,
      1,
      '不得建立第二個角色',
    );
  });
});

test('users.disabled = 1 → resolveUserId 回 403', async () => {
  await withDevAuth('0', () =>
    withServer(async ({ store, engine }) => {
      const baUserId = 'ba-user-uuid-0003';
      const user = seedGoogleIdentity(store, {
        baUserId,
        googleSub: 'google-sub-0003',
        email: 'banned@example.com',
        name: '被停用',
        image: null,
      });
      const session = { session: { id: 'sess-3', userId: baUserId }, user };
      // stub session（不打 Google）
      const stubAuth = { api: { getSession: async () => session } };
      const ctx = { auth: stubAuth, store, engine };
      const req = { query: {}, body: {}, headers: {} };

      const userId = await resolveUserId(req, ctx);
      assert.ok(Number.isInteger(userId));

      store.db.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).run(userId);

      await assert.rejects(
        () => resolveUserId(req, ctx),
        (err) => {
          assert.equal(err.status, 403);
          assert.equal(err.error, 'disabled');
          return true;
        },
      );
    }),
  );
});

test('session 有效時 resolveUserId 回本地 users.id（不是 better-auth 的 uuid）', async () => {
  await withDevAuth('0', () =>
    withServer(async ({ store, engine }) => {
      const baUserId = 'ba-user-uuid-0004';
      const user = seedGoogleIdentity(store, {
        baUserId,
        googleSub: 'google-sub-0004',
        email: 'ok@example.com',
        name: '正常玩家',
        image: null,
      });
      const stubAuth = { api: { getSession: async () => ({ session: { id: 'sess-4' }, user }) } };
      const ctx = { auth: stubAuth, store, engine };

      const userId = await resolveUserId({ query: {}, body: {}, headers: {} }, ctx);
      assert.ok(Number.isInteger(userId), '必須回整數的本地 users.id');
      assert.notEqual(userId, baUserId);

      const row = store.db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
      assert.equal(row.ba_user_id, baUserId);
      assert.equal(row.google_sub, 'google-sub-0004');
    }),
  );
});

test('/api/auth/get-session 無 cookie → null', async () => {
  await withDevAuth('0', () =>
    withServer(async ({ app }) => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/get-session' });
      assert.equal(res.statusCode, 200);
      assert.equal(json(res), null);
    }),
  );
});

test('每 IP 每日「開始註冊/登入」上限 3 次', async () => {
  const { signupStartsToday, recordSignupStart, resetSignupStarts } = await import(
    '../src/auth.js'
  );
  resetSignupStarts();
  const ip = '203.0.113.7';
  assert.equal(signupStartsToday(ip), 0);
  recordSignupStart(ip);
  recordSignupStart(ip);
  recordSignupStart(ip);
  assert.equal(signupStartsToday(ip), 3);
  recordSignupStart(ip);
  assert.equal(signupStartsToday(ip), 4);
  // 另一個 IP 各自計算
  assert.equal(signupStartsToday('198.51.100.9'), 0);
  resetSignupStarts();
  assert.equal(signupStartsToday(ip), 0);
});

test('第 4 次「開始註冊/登入」→ 429（每 IP 每日 3 次上限真的擋得住）', async () => {
  const { resetSignupStarts } = await import('../src/auth.js');
  resetSignupStarts();
  try {
    await withServer(async ({ app }) => {
      const ip = '203.0.113.99';
      const post = () =>
        app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/social',
          headers: { origin: 'https://morowin.win', 'cf-connecting-ip': ip },
          payload: { provider: 'google', callbackURL: 'https://morowin.win/FXSimulator/' },
        });

      for (let i = 0; i < 3; i++) {
        const res = await post();
        assert.equal(res.statusCode, 200, `第 ${i + 1} 次應成功`);
      }
      const fourth = await post();
      assert.equal(fourth.statusCode, 429, '第 4 次應被擋（429）');
      assert.match(fourth.body, /上限|TOO_MANY_REQUESTS/);
    });
  } finally {
    resetSignupStarts();
  }
});
