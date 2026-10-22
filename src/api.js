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
  MAX_ACTIVE_RULES,
  MAX_POSITIONS,
  MIN_NOTIONAL_A,
  SPREAD_HALF,
} from './config.js';
import { minMarginForLeverage } from './account.js';
import { markE4, positionJson, stateJson } from './serialize.js';
import { resolvePct } from './pct.js';
import { ruleJson } from './rules.js';
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
// 停損 / 停利百分比解析（實作在 `src/pct.js`，M2 下單與 M3 規則共用）
// ---------------------------------------------------------------------------

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

  // ------------------------------------------------------------------
  // M3：自動規則（§6.3）
  // ------------------------------------------------------------------
  app.get('/api/rules', async (req) => {
    const userId = resolveUserId(req);
    return {
      max_active: MAX_ACTIVE_RULES,
      rules: engine.rules.listFor(userId).map(ruleJson),
    };
  });

  app.post('/api/rules', async (req) => {
    const body = req?.body ?? {};
    const userId = resolveUserId(req);
    const result = engine.rules.createRule(userId, body);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, rule: ruleJson(result.rule) };
  });

  app.patch('/api/rules/:id', async (req) => {
    const body = req?.body ?? {};
    const userId = resolveUserId(req);
    const id = Number(req?.params?.id);
    if (!Number.isInteger(id)) return { ok: false, reason: 'not_found' };

    const patch = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    for (const key of ['side', 'trigger_price_e4', 'margin_a', 'leverage', 'sl_pct', 'tp_pct', 'confirm']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    const result = engine.rules.updateRule(userId, id, patch);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, rule: ruleJson(result.rule) };
  });

  app.delete('/api/rules/:id', async (req) => {
    const userId = resolveUserId(req);
    const id = Number(req?.params?.id);
    if (!Number.isInteger(id)) return { ok: false, reason: 'not_found' };
    const result = engine.rules.cancelRule(userId, id);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, rule: ruleJson(result.rule) };
  });

  // ------------------------------------------------------------------
  // M3：離線報告（§6.4）
  // ------------------------------------------------------------------
  app.get('/api/report', async (req) => {
    const userId = resolveUserId(req);
    // `scope=live`＝直接用目前的 last_seen_tick 往後算；預設＝最近一次連線時的離線報告
    const scope = req?.query?.scope === 'live' ? 'live' : 'offline';
    return engine.reports.get(userId, { scope });
  });

  app.post('/api/report/ack', async (req) => {
    // 使用者可由 query / body 的 `user` 指定（UI 傳 body: { user }）
    const userId = resolveUserId(req);
    engine.reports.ack(userId);
    return { ok: true };
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
    // M3 §6.4：連線即視為「回到線上」→ 先算好剛結束的離線報告，再把 last_seen_tick 移到現在
    try {
      engine.reports?.onUserOnline(userId);
    } catch {
      /* DB 可能已關閉（測試收尾）：不影響連線 */
    }
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

    const onClose = () => {
      hub.removeClient(client);
      // 該使用者的最後一條連線關閉 → 進入離線狀態（last_seen_tick = 現在）
      if (hub.countFor(userId) === 0) {
        try {
          engine.reports?.onUserOffline(userId);
        } catch {
          /* DB 可能已關閉（測試收尾）：忽略 */
        }
      }
    };
    socket.on('close', onClose);
    socket.on('error', onClose);
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
    return;
  }
  if (type === 'rule.upsert') {
    handleRuleUpsert(ctx, client, msg);
    return;
  }
  if (type === 'rule.delete') {
    handleRuleDelete(ctx, client, msg);
  }
}

/** 使用者身分檢查：訊息帶的 user 必須與連線身分一致 */
function userMatches(client, msg, data) {
  const claimed = msg?.user ?? data?.user;
  if (claimed === undefined || claimed === null || claimed === '') return true;
  return Number(claimed) === client.userId;
}

/**
 * 規則訊息的身分檢查：**只看頂層 `user` 欄位**。
 * `data` 內的 `user` 欄位一律忽略（UI 會在 `rule.upsert` 的 data 內帶 user）。
 */
function userMatchesRule(client, msg) {
  const claimed = msg?.user;
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

// ---------------------------------------------------------------------------
// M3：自動規則（WS）
// ---------------------------------------------------------------------------

/** 規則被拒絕 → `rule.rejected`（穩定原因字串） */
function rejectRule(client, requestId, reason) {
  client.sendText(JSON.stringify({
    type: 'rule.rejected',
    request_id: requestId ?? null,
    data: { reason },
  }));
}

/**
 * `rule.upsert`：建立或更新一條條件開倉規則。
 * 成功 → 由規則引擎廣播 `rule.updated`（帶 request_id）給該使用者的所有連線。
 */
function handleRuleUpsert(ctx, client, msg) {
  const { engine } = ctx;
  const requestId = msg?.request_id ?? null;
  const data = msg?.data ?? {};

  // 身分只看頂層 user（data 內的 user 忽略）
  if (!userMatchesRule(client, msg)) {
    rejectRule(client, requestId, 'user_mismatch');
    return;
  }

  const ruleId = data.id ?? data.rule_id ?? data.ruleId;
  const result = ruleId != null
    ? engine.rules.updateRule(client.userId, Number(ruleId), data, { requestId })
    : engine.rules.createRule(client.userId, data, { requestId });

  if (!result.ok) rejectRule(client, requestId, result.reason);
}

/** `rule.delete`：取消一條規則（回 `rule.updated`，status=cancelled） */
function handleRuleDelete(ctx, client, msg) {
  const { engine } = ctx;
  const requestId = msg?.request_id ?? null;
  const data = msg?.data ?? {};

  // 身分只看頂層 user（data 內的 user 忽略）
  if (!userMatchesRule(client, msg)) {
    rejectRule(client, requestId, 'user_mismatch');
    return;
  }

  const ruleId = Number(data.rule_id ?? data.ruleId ?? data.id);
  if (!Number.isInteger(ruleId)) {
    rejectRule(client, requestId, 'not_found');
    return;
  }

  const result = engine.rules.cancelRule(client.userId, ruleId, { requestId });
  if (!result.ok) rejectRule(client, requestId, result.reason);
}
