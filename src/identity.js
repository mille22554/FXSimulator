/**
 * M3：使用者身分解析（better-auth session → 本地 `users.id`）。
 *
 * 資料流（spec §6.1 / §6.2、m3-auth.md §4、§5）：
 *
 *   session cookie ──► better-auth `ba_user` / `ba_account`
 *                          │
 *                          ├─ Google `sub`（`ba_account.accountId`）──► `users.google_sub`
 *                          └─ better-auth user id ─────────────────► `users.ba_user_id`
 *                                                                    │
 *                                                                    ▼
 *                                                        本地 `users.id`（INTEGER）
 *                                                                │
 *                                                                └─► `accounts`（100,000 A）
 *
 * 規則：
 *   - **只用 Google `sub` 當唯一鍵**（email 可變）。
 *   - 首次登入 → 建立 `users` + `accounts`（起始 100,000 A = 100,000,000 milli-A），
 *     同一個交易（transaction）內完成，之後不再發放。
 *   - `users.disabled = 1` → 403。
 *   - `DEV_AUTH=1`（**僅限非 production**）→ 保留 M2 的 `?user=` / `x-user-id`，
 *     讓既有 51 個測試與本機開發維持原行為。
 */

import { fromNodeHeaders } from 'better-auth/node';

import { DEFAULT_USER_ID, INITIAL_BALANCE_MILLI } from './config.js';
import { isProduction } from './auth.js';

/** 認證錯誤（由 Fastify error handler 轉成 401 / 403） */
export class AuthError extends Error {
  constructor(status, error, message) {
    super(message ?? error);
    this.name = 'AuthError';
    this.status = status;
    this.error = error;
  }
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * 是否啟用開發用身分（`?user=` / `x-user-id`）。
 *
 * - production → **永遠 false**（`NODE_ENV=production`）。
 * - `DEV_AUTH=0` / `false` / `no` → false。
 * - 其他（包含未設定）→ true（本機開發預設；spec：正式環境才會擋未登入）。
 */
export function devAuthEnabled() {
  if (isProduction()) return false;
  const v = String(process.env.DEV_AUTH ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

/**
 * 從請求解析 better-auth session。
 * @returns {Promise<{session:object,user:object}|null>}
 */
export async function getSession(req, authInstance) {
  if (!authInstance) return null;
  try {
    const headers = fromNodeHeaders(req?.headers ?? {});
    const res = await authInstance.api.getSession({ headers });
    return res?.session ? res : null;
  } catch {
    return null;
  }
}

/** `ADMIN_EMAILS` 命中 → role=admin（spec §6.2） */
export function roleForEmail(email) {
  const list = String(process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const e = String(email ?? '').trim().toLowerCase();
  return e && list.includes(e) ? 'admin' : 'player';
}

/**
 * 把 better-auth session 對應到本地 `users` 列；必要時建立（users + accounts）。
 *
 * @param {{session:object,user:object}} session
 * @param {{store:object, engine:object}} ctx
 * @returns {Promise<object|null>} 本地 users 列（snake_case 欄位）
 */
export async function resolveLocalUser(session, ctx) {
  const store = ctx?.store;
  const engine = ctx?.engine;
  if (!session?.user?.id || !store) return null;

  const baUserId = String(session.user.id);
  const email = session.user.email ?? null;
  const name = session.user.name ?? null;
  const image = session.user.image ?? null;

  // 1) 先用 better-auth user id 找（最快、也是主要的連結鍵）
  let row = store.findUserByBaUserId?.(baUserId) ?? null;
  let googleSub = row?.google_sub ?? null;

  if (!row) {
    // 2) 用 Google `sub` 找既有本地帳號（同一 Google 帳號 = 一個角色）
    googleSub = googleSub ?? store.getProviderAccountId?.(baUserId, 'google') ?? null;
    if (googleSub) {
      const bySub = store.findUserByGoogleSub?.(googleSub) ?? null;
      if (bySub) {
        store.linkBaUserId?.(bySub.id, baUserId);
        row = { ...bySub, ba_user_id: baUserId };
      }
    }
  }

  if (!row) {
    // 3) 首次登入 → 建立本地 users + accounts（同一交易）
    googleSub = googleSub ?? store.getProviderAccountId?.(baUserId, 'google') ?? null;
    try {
      row =
        store.createLocalUserWithAccount?.({
          baUserId,
          googleSub,
          email,
          displayName: name,
          avatarUrl: image,
          role: roleForEmail(email),
          balanceMilli: INITIAL_BALANCE_MILLI,
          tick: engine?.ticksExecuted ?? 0,
        }) ?? null;
    } catch (err) {
      // 唯一鍵衝突（同一 Google 帳號的併發首次登入）→ 重新查一次
      row =
        store.findUserByBaUserId?.(baUserId) ??
        (googleSub ? store.findUserByGoogleSub?.(googleSub) ?? null : null);
      if (!row) throw err;
    }
    if (row) {
      // 讓引擎記憶體也知道這個帳號（餘額 100,000 A）
      engine?.ensureAccount?.(row.id, { balanceMilli: INITIAL_BALANCE_MILLI });
    }
    return row;
  }

  // 4) 既有帳號 → 同步顯示名稱／頭像（email 可變，不當唯一鍵；值沒變就不寫）
  const profileChanged =
    (name && row.display_name !== name) || (image && row.avatar_url !== image);
  if (profileChanged) {
    store.updateUserProfile?.(row.id, { displayName: name, avatarUrl: image });
  }
  return row;
}

/**
 * 解析請求的使用者 id（**唯一的接點**，M2 的 `?user=` 也在此收斂）。
 *
 * @param {object} req Fastify request
 * @param {{auth:object, store:object, engine:object}} ctx
 * @returns {Promise<number>} 本地 `users.id`
 * @throws {AuthError} 401（未登入）／403（帳號停用）
 */
export async function resolveUserId(req, ctx) {
  if (devAuthEnabled()) {
    // 開發模式：保留 M2 行為（`?user=` / body.user / `x-user-id`，預設 1）
    const raw = firstDefined(
      req?.query?.user,
      req?.body?.user,
      req?.headers?.['x-user-id'],
    );
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    return DEFAULT_USER_ID;
  }

  const session = await getSession(req, ctx?.auth);
  if (!session) throw new AuthError(401, 'unauthorized', '需要登入');

  const local = await resolveLocalUser(session, ctx);
  if (!local) throw new AuthError(401, 'unauthorized', '帳號尚未建立');
  if (local.disabled) throw new AuthError(403, 'disabled', '帳號已被停用');
  return local.id;
}

/** 本地 users 列 → API 用的 user JSON（不外洩 google_sub / email_verified 等） */
export function userJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email ?? null,
    name: row.display_name ?? null,
    avatar_url: row.avatar_url ?? null,
    role: row.role ?? 'player',
  };
}

export default { resolveUserId, resolveLocalUser, getSession, devAuthEnabled, AuthError };
