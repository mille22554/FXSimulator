/**
 * M2 REST + WebSocket 協定層（contract 為準）。
 *
 * REST：
 *   GET  /healthz
 *   GET  /api/config
 *   GET  /api/state?user=1
 *   GET  /api/candles?limit=60      （最舊 → 最新，上限 600）
 *   GET  /api/events?limit=100      （最新 → 最舊；**絕不**含 type / permanent_share）
 *   POST /api/open
 *   POST /api/close
 *
 * WebSocket：
 *   /ws?user=1 → 立即 `snapshot`，之後每秒 `tick`；接受 `order.open` / `order.close` / `ping`。
 *
 * M2 臨時認證（M3 會換成 session cookie）：
 *   使用者 id 由 `?user=<id>` 或標頭 `x-user-id` 決定，預設 1。
 *   **全部集中在 `resolveUserId()`**，M3 只要換掉這一個函式即可。
 */

import {
  DEFAULT_LEVERAGE,
  DEFAULT_USER_ID,
  FEE_LONG_ANNUAL,
  FEE_SHORT_ANNUAL,
  LEVERAGE_OPTIONS,
  MAINTENANCE_MARGIN_RATE,
  MAX_POSITIONS,
  MIN_NOTIONAL_A,
  MIN_SL_DISTANCE,
  SL_MAX_LIQ_FACTOR,
  SPREAD_HALF,
} from './config.js';
import { liquidationDistance, minMarginForLeverage } from './account.js';
import { markE4, positionJson, stateJson } from './serialize.js';
import { WS_OPEN } from './live.js';

// ---------------------------------------------------------------------------
// 使用者解析（M2 臨時認證；M3 只改這裡）
// ---------------------------------------------------------------------------
function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** 從 query / body / header 解析使用者 id（無效或缺省 → 1） */
export function resolveUserId(req) {
  const raw = firstDefined(
    req?.query?.user,
    req?.body?.user,
    req?.headers?.['x-user-id'],
  );
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_USER_ID;
  return n;
}

// ---------------------------------------------------------------------------
// 錯誤原因（穩定機器字串）
// ---------------------------------------------------------------------------
/**
 * M1 內部原因 → contract 穩定原因字串。
 * contract 明列：insufficient_balance / max_positions / min_notional / max_notional /
 *                debt_no_open / invalid_leverage / invalid_side
 */
const REASON_MAP = {
  side_invalid: 'invalid_side',
  leverage_invalid: 'invalid_leverage',
  margin_invalid: 'invalid_margin',
  margin_step: 'margin_step',
  min_margin: 'min_notional', // 保證金太少 ⇒ 名目低於最小名目
  insufficient_balance: 'insufficient_balance',
  max_positions: 'max_positions',
  min_notional: 'min_notional',
  max_notional: 'max_notional',
  debt_no_open: 'debt_no_open',
  sl_too_close: 'sl_too_close',
  sl_beyond_liq: 'sl_beyond_liq',
  tp_invalid: 'tp_invalid',
  position_not_found: 'not_found',
  position_not_closed: 'not_open',
  user_mismatch: 'user_mismatch',
  invalid_request: 'invalid_request',
};

export function mapReason(reason) {
  if (!reason) return 'unknown';
  return REASON_MAP[reason] ?? reason;
}

// ---------------------------------------------------------------------------
// 停損 / 停利百分比解析
// ---------------------------------------------------------------------------
/**
 * `sl_pct` / `tp_pct` 的解讀（contract 請求範例：`"sl_pct": 0.5` = 0.5%）。
 *
 * 規則（決定性）：
 *   1. **主解讀 = 百分比數字**（0.5 → 0.005 小數比例），與 contract 的請求範例一致。
 *   2. 若百分比解讀違反引擎限制（太小 / 超過強平距離）但「小數比例」解讀合法，
 *      則採小數比例（相容另一種前端寫法）。
 *   3. 兩者都不合法 → 交給引擎產生正確的拒絕原因。
 */
function resolvePct(raw, { kind, leverage }) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { error: `${kind}_invalid` };

  const percent = n / 100;
  const fraction = n;

  if (kind === 'sl') {
    const maxFraction = liquidationDistance(leverage) * SL_MAX_LIQ_FACTOR;
    const ok = (v) => v >= MIN_SL_DISTANCE && v <= maxFraction;
    if (ok(percent)) return { value: percent };
    if (ok(fraction)) return { value: fraction };
    return { value: percent };
  }

  // tp：引擎只要求 > 0；百分比解讀小於 0.05%（低於最小停損距離）時改採小數比例
  if (percent >= MIN_SL_DISTANCE) return { value: percent };
  if (fraction <= 1) return { value: fraction };
  return { value: percent };
}

// ---------------------------------------------------------------------------
// 請求解析
// ---------------------------------------------------------------------------
function parseOrderInput(body, { requireLeverage = true } = {}) {
  const side = body?.side;
  const leverageRaw = body?.leverage ?? body?.leverage_x;
  const leverage = Number(leverageRaw ?? DEFAULT_LEVERAGE);
  const marginRaw = body?.margin_a ?? body?.marginA ?? body?.margin;
  const marginA = Number(marginRaw);

  if (side !== 'long' && side !== 'short') return { error: 'invalid_side' };
  if (requireLeverage && !LEVERAGE_OPTIONS.includes(leverage)) {
    return { error: 'invalid_leverage' };
  }
  if (!Number.isFinite(marginA)) return { error: 'invalid_margin' };

  const sl = resolvePct(body?.sl_pct ?? body?.slPct, { kind: 'sl', leverage });
  if (sl.error) return { error: sl.error };
  const tp = resolvePct(body?.tp_pct ?? body?.tpPct, { kind: 'tp', leverage });
  if (tp.error) return { error: tp.error };

  return { side, leverage, marginA, slPct: sl.value, tpPct: tp.value };
}

function fillJson(result) {
  return {
    price_e4: result.entryPriceE4,
    notional_milli: result.notionalMilli,
    margin_milli: result.marginMilli,
  };
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------
export function registerApi(app, ctx) {
  const { engine } = ctx;

  app.get('/healthz', async () => ({
    ok: true,
    tick_id: Math.max(0, engine.ticksExecuted - 1),
    uptime_s: Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000)),
  }));

  app.get('/api/config', async () => {
    const minMargin = {};
    for (const lev of LEVERAGE_OPTIONS) minMargin[String(lev)] = minMarginForLeverage(lev);
    return {
      leverage: [...LEVERAGE_OPTIONS],
      default_leverage: DEFAULT_LEVERAGE,
      min_margin_a: minMargin,
      max_positions: MAX_POSITIONS,
      min_notional_a: MIN_NOTIONAL_A,
      spread_per_side: SPREAD_HALF,
      fee_long_annual: FEE_LONG_ANNUAL,
      fee_short_annual: FEE_SHORT_ANNUAL,
      maintenance_rate: MAINTENANCE_MARGIN_RATE,
    };
  });

  app.get('/api/state', async (req) => {
    const userId = resolveUserId(req);
    return stateJson({ engine, userId });
  });

  app.get('/api/candles', async (req) => {
    const limit = clampLimit(req?.query?.limit, 60, 600);
    return engine.candles(limit).map((c) => ({
      minute_id: c.minute_id,
      started_at: c.started_at ?? null,
      open_e4: c.open_e4 ?? null,
      high_e4: c.high_e4 ?? null,
      low_e4: c.low_e4 ?? null,
      close_e4: c.close_e4 ?? null,
      base_close_e4: c.base_close_e4 ?? null,
      net_notional_milli: c.net_notional_milli ?? 0,
      volume_notional_milli: c.volume_notional_milli ?? 0,
    }));
  });

  app.get('/api/events', async (req) => {
    const limit = clampLimit(req?.query?.limit, 100, 100);
    // engine.events() 回傳最舊 → 最新；contract 要求最新 → 最舊
    return engine.events(limit)
      .map((ev) => ({
        id: ev.id,
        tick_id: ev.tick_id ?? ev.ts ?? 0,
        headline: ev.headline ?? '',
        impact_jump: ev.impact_jump ?? ev.pct ?? 0,
      }))
      .reverse();
  });

  app.post('/api/open', async (req) => {
    const body = req?.body ?? {};
    const userId = resolveUserId(req);
    const parsed = parseOrderInput(body);
    if (parsed.error) return { ok: false, reason: parsed.error };

    const result = engine.open(userId, {
      side: parsed.side,
      marginA: parsed.marginA,
      leverage: parsed.leverage,
      slPct: parsed.slPct,
      tpPct: parsed.tpPct,
    });
    if (!result.ok) return { ok: false, reason: mapReason(result.reason) };

    return {
      ok: true,
      position: positionJson(result.position, markE4(engine.market)),
      fill: fillJson(result),
      ...(result.truncated ? { truncated: true } : {}),
    };
  });

  app.post('/api/close', async (req) => {
    const body = req?.body ?? {};
    const userId = resolveUserId(req);
    const positionId = Number(body.position_id ?? body.positionId);
    if (!Number.isInteger(positionId)) return { ok: false, reason: 'not_found' };

    const result = engine.close(userId, positionId);
    if (!result.ok) return { ok: false, reason: mapReason(result.reason) };

    return {
      ok: true,
      exit_price_e4: result.exitPriceE4,
      pnl_milli: result.pnlMilli,
    };
  });

  app.setErrorHandler((err, req, reply) => {
    reply.code(400).send({ ok: false, reason: 'invalid_request', message: err?.message });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ ok: false, reason: 'not_found' });
  });
}

function clampLimit(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
export function registerWs(app, ctx) {
  const { engine, hub } = ctx;

  app.get('/ws', { websocket: true }, (socket, req) => {
    const userId = resolveUserId(req);
    const client = {
      userId,
      sendText: (text) => {
        if (socket.readyState !== WS_OPEN) return;
        try {
          socket.send(text);
        } catch {
          /* 連線已斷 */
        }
      },
    };

    hub.addClient(client);
    // 立即 snapshot（重連也會重新送）
    hub.sendTo(client, { type: 'snapshot', data: stateJson({ engine, userId }) });

    socket.on('message', (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        return; // 壞掉的 JSON：忽略
      }
      handleMessage(ctx, client, msg);
    });

    socket.on('close', () => hub.removeClient(client));
    socket.on('error', () => hub.removeClient(client));
  });
}

function handleMessage(ctx, client, msg) {
  if (!msg || typeof msg !== 'object') return;
  const type = msg.type;

  if (type === 'ping') {
    ctx.hub.sendTo(client, { type: 'pong' });
    return;
  }
  if (type === 'order.open') {
    handleOrderOpen(ctx, client, msg);
    return;
  }
  if (type === 'order.close') {
    handleOrderClose(ctx, client, msg);
  }
}

/** 使用者身分檢查：訊息帶的 user 必須與連線身分一致 */
function userMatches(client, msg, data) {
  const claimed = msg?.user ?? data?.user;
  if (claimed === undefined || claimed === null || claimed === '') return true;
  return Number(claimed) === client.userId;
}

function reject(client, requestId, reason) {
  client.sendText(JSON.stringify({
    type: 'order.rejected',
    request_id: requestId ?? null,
    data: { reason },
  }));
}

function handleOrderOpen(ctx, client, msg) {
  const { engine, hub } = ctx;
  const requestId = msg?.request_id ?? null;
  const data = msg?.data ?? {};

  if (!userMatches(client, msg, data)) {
    reject(client, requestId, 'user_mismatch');
    return;
  }

  const parsed = parseOrderInput(data);
  if (parsed.error) {
    reject(client, requestId, parsed.error);
    return;
  }

  const result = engine.open(client.userId, {
    side: parsed.side,
    marginA: parsed.marginA,
    leverage: parsed.leverage,
    slPct: parsed.slPct,
    tpPct: parsed.tpPct,
  });
  if (!result.ok) {
    reject(client, requestId, mapReason(result.reason));
    return;
  }

  hub.sendTo(client, {
    type: 'order.filled',
    request_id: requestId,
    data: {
      side: parsed.side,
      position: positionJson(result.position, markE4(engine.market)),
      fill: fillJson(result),
      ...(result.truncated ? { truncated: true } : {}),
    },
  });
}

function handleOrderClose(ctx, client, msg) {
  const { engine, hub } = ctx;
  const requestId = msg?.request_id ?? null;
  const data = msg?.data ?? {};

  if (!userMatches(client, msg, data)) {
    reject(client, requestId, 'user_mismatch');
    return;
  }

  const positionId = Number(data.position_id ?? data.positionId);
  if (!Number.isInteger(positionId)) {
    reject(client, requestId, 'not_found');
    return;
  }

  const result = engine.close(client.userId, positionId);
  if (!result.ok) {
    reject(client, requestId, mapReason(result.reason));
    return;
  }

  const position = result.position;
  hub.sendTo(client, {
    type: 'order.filled',
    request_id: requestId,
    data: {
      side: position.side,
      position: positionJson(position, markE4(engine.market)),
      fill: {
        price_e4: result.exitPriceE4,
        notional_milli: position.notionalMilli,
        margin_milli: position.marginMilli,
      },
      exit_price_e4: result.exitPriceE4,
      pnl_milli: result.pnlMilli,
    },
  });
}
