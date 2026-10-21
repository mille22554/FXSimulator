#!/usr/bin/env node
/**
 * FXSimulator M2 伺服器（HTTP + WebSocket，單一 process，含 tick 迴圈）。
 *
 *   node src/server.js           （或 npm start）
 *
 * 環境變數：
 *   HOST   預設 127.0.0.1
 *   PORT   預設 2641
 *   FXSIM_DB  預設 ./fxsim.db
 *   FXSIM_SEED 預設 42
 *
 * nginx 會把 `/FXSimulator/` 前綴剝掉（`proxy_pass http://127.0.0.1:2641/`），
 * 所以本服務自帶路徑：`/`（靜態頁）、`/api/*`、`/ws`。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';

import { DEFAULT_SEED, DEFAULT_USER_ID } from './config.js';
import { Engine } from './engine.js';
import { createMemoryStore, openSqliteStore } from './db.js';
import { LiveHub } from './live.js';
import { registerApi, registerWs } from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 2641;

/**
 * 開啟資料層：優先 SQLite（better-sqlite3），原生模組不可用時退回記憶體 store。
 * @param {string|null} dbPath
 */
export async function openStore(dbPath) {
  if (!dbPath) return createMemoryStore();
  try {
    return await openSqliteStore(dbPath);
  } catch (err) {
    console.error(`[fxsim] 無法開啟 SQLite（${err.message}）→ 改用記憶體 store`);
    return createMemoryStore();
  }
}

/**
 * 建立伺服器（不 listen、不啟動 tick 迴圈）。
 *
 * @param {object} opts
 * @param {string|null} opts.dbPath  SQLite 路徑（null → 記憶體 store）
 * @param {number} opts.seed
 * @param {number} opts.userId
 * @param {number} opts.tickMs      tick 間隔（毫秒）
 * @param {boolean} opts.live       是否啟動 tick 迴圈（測試用 false）
 */
export async function buildServer({
  dbPath = null,
  seed = DEFAULT_SEED,
  userId = DEFAULT_USER_ID,
  tickMs = 1000,
  live = false,
} = {}) {
  const store = await openStore(dbPath);
  const engine = new Engine({ seed, store, userId });
  engine.load();
  engine.init();

  const hub = new LiveHub({ engine, tickMs });

  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerApi(app, { engine, hub, startedAt: Date.now() });
  registerWs(app, { engine, hub, startedAt: Date.now() });
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['index.html'],
    wildcard: true,
  });

  if (live) hub.start();

  return { app, engine, store, hub };
}

/** 關閉：停迴圈 → 存檔 → 關 HTTP → 關 DB */
export async function shutdown({ app, engine, store, hub }) {
  try {
    hub?.stop();
  } catch {
    /* ignore */
  }
  try {
    engine?.persist?.();
  } catch {
    /* ignore */
  }
  try {
    await app?.close();
  } catch {
    /* ignore */
  }
  try {
    store?.close?.();
  } catch {
    /* ignore */
  }
}

async function main() {
  const host = process.env.HOST || DEFAULT_HOST;
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const dbPath = process.env.FXSIM_DB ?? join(process.cwd(), 'fxsim.db');
  const seed = process.env.FXSIM_SEED ? Number(process.env.FXSIM_SEED) : DEFAULT_SEED;

  const ctx = await buildServer({ dbPath, seed, live: true });
  const { app, engine, store, hub } = ctx;

  let closing = false;
  const stop = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[fxsim] 收到 ${signal}，正在關閉…`);
    await shutdown(ctx);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  try {
    await app.listen({ host, port });
    console.log(`[fxsim] 監聽 http://${host}:${port}（靜態頁 /、API /api/*、WS /ws）`);
    console.log(`[fxsim] DB ${dbPath}｜seed ${seed}｜tick 每 ${1000}ms`);
  } catch (err) {
    console.error(`[fxsim] 啟動失敗：${err.message}`);
    await shutdown(ctx);
    process.exit(1);
  }

  // 避免 process 閒置時被判定為可回收（引擎已在 tick 迴圈中運作）
  void engine;
  void store;
  void hub;
}

const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
