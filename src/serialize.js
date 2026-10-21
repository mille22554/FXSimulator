/**
 * API 序列化層（contract「Units」與「Shared types」）。
 *
 * 單位約定（contract §Units）：
 *   - 金額：整數 milli-A（1 A = 1,000），欄位結尾 `_milli`
 *   - 價格：整數 e4（5.0000 = 50,000），欄位結尾 `_e4`
 *   - 百分比 / 衝擊：小數比例（0.0002 = 0.02%）
 *   - `server_time`：ISO 字串；經濟排序用 `tick_id`
 *
 * 隱私規則（spec §7.7 / contract）：
 *   事件 payload **絕對不含** `type` 與 `permanent_share`（玩家不得由 API 推知
 *   事件類型與永久比例）。此檔是唯一對外輸出的地方，規則只在此實作一次。
 *
 * 本檔只做「讀取 M1 物件 → 組出 JSON」，不修改任何經濟邏輯。
 */

import { MILLI_PER_A } from './config.js';
import { priceToE4 } from './money.js';

/** 目前標記價（e4 整數） */
export function markE4(market) {
  return priceToE4(market.price);
}

/**
 * 取得（必要時建立）使用者帳號。
 * 第一次看到某 userId 時把帳號寫進 store，避免重啟後餘額被重設。
 */
export function ensureUserAccount(engine, userId) {
  const existed = engine.accounts.has(userId);
  const acct = engine.ensureAccount(userId);
  if (!existed) {
    try {
      engine.store?.saveUser?.({ id: userId, created_at: engine.ticksExecuted });
      engine.store?.saveAccount?.({
        user_id: userId,
        balance_milli: acct.balanceMilli,
        settled_tick_id: acct.settledTickId,
        last_settled_tick: acct.settledTickId,
        created_at: engine.ticksExecuted,
      });
    } catch {
      /* 記憶體 store 或唯讀情況：忽略（帳號仍存在於引擎記憶體） */
    }
  }
  return acct;
}

/** 目前 tick_id（0-based，最後一個已執行的 tick；尚未跑 tick 時為 0） */
export function currentTickId(engine) {
  return Math.max(0, engine.ticksExecuted - 1);
}

/**
 * Position → JSON（contract「Shared types」）。
 * `pnl_milli`：未平倉部位 = 以當前標記價計算的浮動損益；已平倉 = 已實現損益。
 */
export function positionJson(position, markE4Value = null) {
  const pnl = position.pnlMilliAt(markE4Value);
  return {
    id: position.id,
    side: position.side,
    notional_milli: position.notionalMilli,
    leverage: position.leverage,
    entry_price_e4: position.entryPriceE4,
    margin_milli: position.marginMilli,
    liq_price_e4: position.liqPriceE4,
    sl_price_e4: position.slPriceE4 ?? null,
    tp_price_e4: position.tpPriceE4 ?? null,
    pnl_milli: pnl,
    status: position.status,
  };
}

/** Market → JSON（`withLiquidity` 時附上 L_milli） */
export function marketJson(market, { withLiquidity = false } = {}) {
  const out = {
    price_e4: priceToE4(market.price),
    base_price_e4: priceToE4(market.basePrice),
    impact: market.impactMultiplier() - 1,
    net_notional_milli: Math.round(market.netNotionalA * MILLI_PER_A),
  };
  if (withLiquidity) out.L_milli = Math.round(market.L * MILLI_PER_A);
  return out;
}

/** Account → JSON */
export function accountJson(acct, tickCount) {
  return {
    balance_milli: acct.balanceMilli,
    available_milli: acct.availableMilli(tickCount),
    equity_milli: acct.equityMilli(tickCount),
    margin_milli: acct.totalMarginMilli,
    settled_tick_id: acct.settledTickId,
  };
}

/**
 * 事件 → JSON（**永不**輸出 type / permanent_share / decay_half_life）。
 * 同時相容 SQLite row（tick_id / impact_jump）與記憶體 store（ts / pct）。
 */
export function eventJson(ev) {
  return {
    id: ev.id,
    tick_id: ev.tick_id ?? ev.ts ?? 0,
    headline: ev.headline ?? '',
    impact_jump: ev.impact_jump ?? ev.pct ?? 0,
  };
}

/** 1 分 K 線 → JSON（不含 supply_a_milli） */
export function candleJson(c) {
  return {
    minute_id: c.minute_id,
    started_at: c.started_at ?? null,
    open_e4: c.open_e4 ?? null,
    high_e4: c.high_e4 ?? null,
    low_e4: c.low_e4 ?? null,
    close_e4: c.close_e4 ?? null,
    base_close_e4: c.base_close_e4 ?? null,
    net_notional_milli: c.net_notional_milli ?? 0,
    volume_notional_milli: c.volume_notional_milli ?? 0,
  };
}

/** 完整狀態（GET /api/state 與 WS `snapshot` 共用同一形狀） */
export function stateJson({ engine, userId, candleLimit = 60, eventLimit = 100 }) {
  const acct = ensureUserAccount(engine, userId);
  const mark = markE4(engine.market);
  return {
    server_time: new Date().toISOString(),
    tick_id: currentTickId(engine),
    market: marketJson(engine.market, { withLiquidity: true }),
    account: accountJson(acct, engine.ticksExecuted),
    positions: acct.openPositions().map((p) => positionJson(p, mark)),
    candles: engine.candles(candleLimit).map(candleJson),
    events: engine.events(eventLimit).map(eventJson).reverse(),
  };
}

/** 每秒推送的 tick（WS `tick`） */
export function tickJson({ engine, userId }) {
  const acct = ensureUserAccount(engine, userId);
  const mark = markE4(engine.market);
  return {
    server_time: new Date().toISOString(),
    tick_id: currentTickId(engine),
    market: marketJson(engine.market),
    account: accountJson(acct, engine.ticksExecuted),
    positions: acct.openPositions().map((p) => positionJson(p, mark)),
  };
}
