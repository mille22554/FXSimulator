/**
 * M3：Google 登入（better-auth）— spec §6.1 / §6.2 ＋ m3-auth.md。
 *
 * 職責：
 *   1. 建立 better-auth 實例（Google provider、cookie session、`ba_*` 資料表）。
 *   2. 提供 Fastify 掛載用的 handler（`auth.handler` ＋ `fromNodeHeaders`）。
 *   3. 每 IP 每日「開始註冊／登入」次數上限（§6.1：3 次／IP／日）。
 *
 * 重要陷阱（m3-auth.md §9）：
 *   - `baseURL` **只能放 origin**（不可含 `/FXSimulator`）；路徑由 `basePath` 決定。
 *     nginx 會剝掉 `/FXSimulator/` 前綴，Node 看到的是 `/`、`/api/*`、`/ws`。
 *   - Google redirect URI 必須**顯式**指定公開網址（含 `/FXSimulator`），
 *     否則 better-auth 會組成 `https://morowin.win/api/auth/callback/google`（錯誤）。
 *   - 不要把 better-auth 指向既有的 `accounts` 表（那是 FXSimulator 的資產表，
 *     `accounts.user_id` 是 INTEGER）。better-auth 一律用 `ba_*` 表。
 *
 * 環境變數（正式環境由 systemd / .env 提供，**不可** commit）：
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / BETTER_AUTH_SECRET
 *   BETTER_AUTH_BASE_URL   本機測試用（預設 https://morowin.win）
 *   TRUSTED_ORIGINS        額外允許的 origin（逗號分隔）
 *   ADMIN_EMAILS           命中者 role=admin（spec §6.2）
 */

import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';

// ---------------------------------------------------------------- 設定常數

/** 公開 origin（**不可**含 `/FXSimulator`） */
export const PUBLIC_ORIGIN = 'https://morowin.win';
/** better-auth 掛載路徑 */
export const AUTH_BASE_PATH = '/api/auth';
/** Google OAuth redirect URI（必須與 GCP Console 完全一致，含 `/FXSimulator`） */
export const GOOGLE_REDIRECT_URI = 'https://morowin.win/FXSimulator/api/auth/callback/google';
/** 每 IP 每日「開始註冊／登入」上限（§6.1） */
export const SIGNUP_LIMIT_PER_IP_PER_DAY = 3;
/** session 效期：7 天；每 1 天更新一次（§6.1 cookie session） */
export const SESSION_EXPIRES_IN_SEC = 60 * 60 * 24 * 7;
export const SESSION_UPDATE_AGE_SEC = 60 * 60 * 24;

/** 開發用預設 secret（**僅限非 production**；production 未設 BETTER_AUTH_SECRET 會直接啟動失敗） */
const DEV_SECRET = 'fxsimulator-dev-only-secret-please-set-BETTER_AUTH_SECRET';

/** 是否為正式環境 */
export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

// ---------------------------------------------------------------- 註冊次數限制
/**
 * 每 IP 每日「開始註冊／登入」計數（記憶體；單 process 即可，Alpha 規模足夠）。
 * key = IP，value = { day: 'YYYY-MM-DD'(UTC), count }
 */
const signupStarts = new Map();

/** UTC 日期字串（跨日自動歸零） */
function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** 某 IP 今日已開始的註冊／登入次數 */
export function signupStartsToday(ip, now = new Date()) {
  const rec = signupStarts.get(ip);
  if (!rec || rec.day !== utcDay(now)) return 0;
  return rec.count;
}

/** 記錄一次「開始註冊／登入」；回傳累計次數 */
export function recordSignupStart(ip, now = new Date()) {
  const day = utcDay(now);
  const rec = signupStarts.get(ip);
  if (!rec || rec.day !== day) {
    signupStarts.set(ip, { day, count: 1 });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

/** 清空計數（測試用） */
export function resetSignupStarts() {
  signupStarts.clear();
}

/**
 * 取出請求的 client IP。
 *
 * 優先序（spec §6.1 / §10：以 `CF-Connecting-IP` 判定）：
 *   cf-connecting-ip → x-real-ip → x-forwarded-for[0] → 'unknown'
 *
 * ⚠️ nginx 端的 `X-Real-IP` 是 cloudflared 的來源 IP（不是玩家 IP），
 *    因此真實判定必須靠 Cloudflare 注入的 `CF-Connecting-IP`。
 */
export function clientIpFromHeaders(headers) {
  const pick = (name) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const v = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v ?? null;
  };
  return (
    pick('cf-connecting-ip') ||
    pick('x-real-ip') ||
    String(pick('x-forwarded-for') ?? '').split(',')[0]?.trim() ||
    'unknown'
  );
}

// ---------------------------------------------------------------- options

/** 允許的 origin（CSRF / callbackURL 檢查） */
export function trustedOrigins() {
  const list = [PUBLIC_ORIGIN, 'http://127.0.0.1:2641', 'http://localhost:2641'];
  const extra = process.env.TRUSTED_ORIGINS;
  if (extra) {
    for (const raw of String(extra).split(',')) {
      const o = raw.trim();
      if (o) list.push(o);
    }
  }
  return [...new Set(list)];
}

/**
 * 產生 better-auth 選項。
 * @param {object} db better-sqlite3 的 Database 實例（與 FXSimulator 共用同一個連線）
 */
export function authOptions(db) {
  const secret = process.env.BETTER_AUTH_SECRET || (isProduction() ? undefined : DEV_SECRET);
  return {
    appName: 'FXSimulator',
    // ⚠️ 只能放 origin（m3-auth.md §9）
    baseURL: process.env.BETTER_AUTH_BASE_URL || PUBLIC_ORIGIN,
    basePath: AUTH_BASE_PATH,
    secret,
    trustedOrigins: trustedOrigins(),
    database: db,

    // v1 只開放 Google 登入（spec §6.1：帳密登入為 backlog）
    emailAndPassword: { enabled: false },

    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID || 'google-client-id-placeholder',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'google-client-secret-placeholder',
        // ⚠️ 必須顯式指定公開網址（含 /FXSimulator）
        redirectURI: GOOGLE_REDIRECT_URI,
        requireEmailVerification: true,
        prompt: 'select_account',
      },
    },

    user: {
      modelName: 'ba_user',
      validateUserInfo: ({ user, source }) => {
        if (source.method !== 'oauth' || source.oauth?.providerId !== 'google') return;
        const ok =
          source.oauth.profile?.email_verified === true || user.emailVerified === true;
        if (!ok) {
          return {
            error: 'email_not_verified',
            errorDescription: '請使用已驗證的 Google 帳號',
          };
        }
      },
    },
    session: {
      modelName: 'ba_session',
      expiresIn: SESSION_EXPIRES_IN_SEC,
      updateAge: SESSION_UPDATE_AGE_SEC,
    },
    account: { modelName: 'ba_account' },
    verification: { modelName: 'ba_verification' },

    advanced: {
      // Secure cookie 只在正式環境開（§10：Secure / HttpOnly / SameSite=Lax）
      useSecureCookies: isProduction(),
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'] },
      database: { generateId: 'uuid' },
      skipTrailingSlashes: true,
    },

    // 每位 IP 每日最多 3 次「開始註冊／登入」（§6.1）
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const path = ctx?.path ?? '';
        if (!path.endsWith('/sign-in/social')) return;
        const ip = clientIpFromHeaders(ctx?.request?.headers);
        if (signupStartsToday(ip) >= SIGNUP_LIMIT_PER_IP_PER_DAY) {
          throw new APIError('TOO_MANY_REQUESTS', { message: '此 IP 今日註冊次數已達上限' });
        }
        recordSignupStart(ip);
      }),
    },
  };
}

// ---------------------------------------------------------------- 實例

/** 目前建立好的 better-auth 實例（`initAuth()` 設定；null = 尚未初始化） */
export let auth = null;
let authDb = null;

/**
 * 建立（或沿用）better-auth 實例。
 * 同一個 DB 只會建立一次（避免重複的 schema 檢查／事件監聽）。
 * @param {object} db better-sqlite3 Database 實例
 */
export function initAuth(db) {
  // 正式環境必須顯式設定 secret：better-auth 的檢查是非同步的（會變成未處理的重拒絕），
  // 這裡先擋下來，讓服務在啟動時就明確失敗。
  const secret = process.env.BETTER_AUTH_SECRET;
  if (isProduction()) {
    if (!secret) {
      throw new Error('BETTER_AUTH_SECRET 未設定（正式環境必須設定）');
    }
    if (secret.length < 32) {
      throw new Error('BETTER_AUTH_SECRET 長度不足 32 字元');
    }
  }
  if (auth && authDb === db) return auth;
  auth = betterAuth(authOptions(db));
  authDb = db;
  return auth;
}

/** 取得目前實例（未初始化 → null） */
export function getAuth() {
  return auth;
}

// ---------------------------------------------------------------- Fastify 掛載

/**
 * 把 better-auth 掛到 `/api/auth/*`。
 *
 * 用 `auth.handler`（Fetch API）而不是 `toNodeHandler`；
 * `set-cookie` 必須逐條送出（`Headers.forEach` 會把多個 cookie 合併成一個字串，
 * `Expires=` 裡的逗號會破壞 cookie）。
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} authInstance better-auth 實例
 */
export function registerAuthRoutes(app, authInstance) {
  if (!authInstance) return;

  app.all(`${AUTH_BASE_PATH}/*`, async (request, reply) => {
    const proto = request.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'http';
    const host =
      request.headers['x-forwarded-host']?.split(',')[0]?.trim() ||
      request.headers.host ||
      'localhost';
    const url = new URL(request.url, `${proto}://${host}`);

    const req = new Request(url, {
      method: request.method,
      headers: fromNodeHeaders(request.headers),
      ...(request.body != null ? { body: JSON.stringify(request.body) } : {}),
    });

    const res = await authInstance.handler(req);
    reply.status(res.status);

    // set-cookie 逐條送出（其餘標頭照抄）
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    res.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'set-cookie') return;
      reply.header(k, v);
    });
    if (setCookies.length > 0) reply.header('set-cookie', setCookies);
    else {
      const single = res.headers.get('set-cookie');
      if (single) reply.header('set-cookie', single);
    }

    return reply.send(res.body ? await res.text() : null);
  });
}

export default { initAuth, getAuth, registerAuthRoutes, authOptions };
