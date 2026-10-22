#!/usr/bin/env node
/**
 * M3：better-auth schema migration（spec §6.1 / m3-auth.md §6）。
 *
 *   node scripts/migrate-auth.js [dbPath]
 *
 * dbPath 省略時依序取 `FXSIM_DB` → `<repo>/fxsim.db`。
 *
 * 做兩件事：
 *   1. `getMigrations(auth.options).runMigrations()` → 建立 / 補齊
 *      `ba_user` / `ba_session` / `ba_account` / `ba_verification`。
 *      （**不要**用 `npx auth migrate`：CLI 需要 Node >= 22.12）
 *   2. `users.ba_user_id`（本地帳號 ↔ better-auth 的連結鍵，TEXT UNIQUE 可空）
 *      ＋ unique index。既有 DB 缺欄位時補上（冪等）。
 *
 * ⚠️ 正式環境請先載入環境變數（secret / Google client id）：
 *      set -a; . /opt/fxsimulator/.env; set +a; node scripts/migrate-auth.js
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getMigrations } from 'better-auth/db/migration';

import { initAuth, authOptions } from '../src/auth.js';
import { openSqliteStore } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** 資料庫路徑：命令列引數 → FXSIM_DB → <repo>/fxsim.db */
export function resolveDbPath(arg = process.argv[2]) {
  if (arg) return resolve(arg);
  if (process.env.FXSIM_DB) return resolve(process.env.FXSIM_DB);
  return join(ROOT, 'fxsim.db');
}

/** 補上 `users.ba_user_id` 欄位與 unique index（冪等） */
export function ensureBaUserIdColumn(db) {
  const cols = new Set(db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name));
  if (!cols.has('ba_user_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN ba_user_id TEXT`);
    console.log('[migrate-auth] ✅ users.ba_user_id 欄位已新增');
  } else {
    console.log('[migrate-auth] · users.ba_user_id 欄位已存在');
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ba_user_id ON users(ba_user_id)`);
  console.log('[migrate-auth] ✅ idx_users_ba_user_id 就緒');
}

/** 列出 ba_* 資料表（驗證用） */
export function listAuthTables(db) {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ba_%' ORDER BY name`)
    .all();
  return rows.map((r) => r.name);
}

export async function main() {
  const dbPath = resolveDbPath();
  console.log(`[migrate-auth] DB：${dbPath}`);

  const store = await openSqliteStore(dbPath);
  try {
    // 1) 先用未解析的 options 跑 migration（乾淨、不會噴 schema mismatch）
    const pre = await getMigrations(authOptions(store.db));
    console.log(
      '[migrate-auth] 待建立資料表：',
      pre.toBeCreated.length ? pre.toBeCreated.map((t) => t.table) : '（無）',
    );
    console.log(
      '[migrate-auth] 待新增欄位：',
      pre.toBeAdded.length
        ? pre.toBeAdded.map((t) => `${t.table}(${Object.keys(t.fields).join(', ')})`)
        : '（無）',
    );
    console.log(
      '[migrate-auth] 待新增索引：',
      pre.toBeAddedIndexes.length ? pre.toBeAddedIndexes.map((t) => t.name) : '（無）',
    );
    await pre.runMigrations();

    // 2) 正規流程：`getMigrations(auth.options).runMigrations()`（冪等 → 無待建項目）
    const auth = initAuth(store.db);
    const { toBeCreated, toBeAdded, toBeAddedIndexes, runMigrations } = await getMigrations(
      auth.options,
    );
    console.log(
      '[migrate-auth] 二次檢查（auth.options）待建立：',
      toBeCreated.length ? toBeCreated.map((t) => t.table) : '（無）',
    );
    console.log(
      '[migrate-auth] 二次檢查待新增欄位：',
      toBeAdded.length ? toBeAdded.map((t) => t.table) : '（無）',
    );
    console.log(
      '[migrate-auth] 二次檢查待新增索引：',
      toBeAddedIndexes.length ? toBeAddedIndexes.map((t) => t.name) : '（無）',
    );
    await runMigrations();
    console.log('[migrate-auth] ✅ better-auth schema 完成（冪等）');

    ensureBaUserIdColumn(store.db);

    // 等 better-auth 的 schema 檢查跑完（初始化是非同步的）→ 確定部署後可用
    try {
      await auth.api.getSession({ headers: new Headers() });
      console.log('[migrate-auth] ✅ schema 檢查通過（請求可正常處理）');
    } catch (err) {
      console.error('[migrate-auth] ❌ schema 檢查失敗：', err?.message ?? err);
      process.exitCode = 1;
    }

    console.log('[migrate-auth] ba_* 資料表：', listAuthTables(store.db).join(', ') || '（無）');
  } finally {
    store.close();
  }
}

const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error('[migrate-auth] 失敗：', err);
    process.exit(1);
  });
}

export default { main, resolveDbPath, ensureBaUserIdColumn, listAuthTables };
