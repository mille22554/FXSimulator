/**
 * 離線報告（M3，spec §6.4 ＋ contract「GET /api/report」）。
 *
 * 報告區間 = `[last_seen_tick, now]`：
 *   - `last_seen_tick` 存在 `accounts` 表，**WS 連線時更新**（contract），
 *     斷線時也會更新（離線期間的起點 = 斷線那一刻）。
 *   - WS 連線的那一刻會先把「剛結束的離線期間」算好並快取（pending report），
 *     再把 `last_seen_tick` 移到現在 → 玩家在線時仍看得到登入前的離線報告。
 *
 * 金額一律整數 milli-A、價格整數 e4、時間用 `tick_id`（1 tick = 1 秒市場時間）。
 */

import { INCOME_MILLI_PER_TICK } from './config.js';

/** 報告的觸發事件種類（contract：`open|sl|tp|liquidation|skipped`） */
export const TRIGGER_KINDS = Object.freeze(['open', 'sl', 'tp', 'liquidation', 'skipped']);

export class ReportService {
  /** @param {object} opts @param {import('./engine.js').Engine} opts.engine */
  constructor({ engine }) {
    this.engine = engine;
    /** @type {Map<number, object>} userId → 最近一次連線時算好的離線報告 */
    this.pending = new Map();
  }

  currentTickId() {
    return Math.max(0, this.engine.ticksExecuted - 1);
  }

  // ------------------------------------------------------------ 在線 / 離線
  /**
   * WS 連線：算出剛結束的離線報告 → 更新 `last_seen_tick` 與期間淨值高低點。
   * @returns {object} 離線報告
   */
  onUserOnline(userId) {
    const engine = this.engine;
    const acct = engine.ensureAccount(userId);
    const until = this.currentTickId();
    const since = acct.lastSeenTick ?? 0;

    // 第一次上線（last_seen_tick 尚未建立）→ 沒有「離線期間」可言，
    // 直接從現在開始追蹤，避免新帳號一登入就跳出離線報告。
    if (since <= 0) {
      this.pending.delete(userId);
      this.#markSeen(acct, until);
      return null;
    }

    // 先算離線報告（用「上線前」的 equity_seen 與期間高低點）
    const report = this.#build(userId, { since, until });
    this.pending.set(userId, report);

    // 再把 last_seen_tick 移到現在並重設期間高低點
    this.#markSeen(acct, until);
    return report;
  }

  /** WS 斷線：離線期間從此刻開始 → 更新 last_seen_tick 並重設高低點 */
  onUserOffline(userId) {
    const engine = this.engine;
    const acct = engine.ensureAccount(userId);
    this.#markSeen(acct, this.currentTickId());
    this.pending.delete(userId);
  }

  #markSeen(acct, tickId) {
    const engine = this.engine;
    acct.lastSeenTick = tickId;
    acct.equitySeenMilli = acct.equityMilli(engine.ticksExecuted);
    acct.equityHighMilli = acct.equitySeenMilli;
    acct.equityLowMilli = acct.equitySeenMilli;
    engine.persistAccountMeta?.(acct);
  }

  // ------------------------------------------------------------ 查詢
  /**
   * 取報告。
   * @param {number} userId
   * @param {object} opts
   * @param {'offline'|'live'} opts.scope `offline`（預設）＝最近一次連線時的離線報告；
   *   `live`＝直接用目前的 `last_seen_tick` 往後算到現在。
   */
  get(userId, { scope = 'offline' } = {}) {
    const pending = this.pending.get(userId);
    if (scope !== 'live' && pending && this.#isMeaningful(pending)) return pending;

    const acct = this.engine.ensureAccount(userId);
    const until = this.currentTickId();
    const since = acct.lastSeenTick ?? 0;
    return this.#build(userId, { since, until });
  }

  /** 報告已被玩家收下 → 把 last_seen_tick 移到現在（contract：ack 為選用） */
  ack(userId) {
    const acct = this.engine.ensureAccount(userId);
    const until = this.currentTickId();
    this.#markSeen(acct, until);
    this.pending.delete(userId);
    return { ok: true, since_tick: until, until_tick: until };
  }

  /** 離線報告「有意義」：有經過時間或有事發 */
  #isMeaningful(report) {
    if (!report) return false;
    if (report.until_tick > report.since_tick) return true;
    return (report.triggers?.length ?? 0) > 0;
  }

  // ------------------------------------------------------------ 計算
  #build(userId, { since, until }) {
    const engine = this.engine;
    const acct = engine.ensureAccount(userId);
    const span = Math.max(0, until - since);

    const equityEnd = acct.equityMilli(engine.ticksExecuted);
    const equityStart = acct.equitySeenMilli != null
      ? acct.equitySeenMilli
      : equityEnd - INCOME_MILLI_PER_TICK * span;
    const equityHigh = acct.equityHighMilli != null ? acct.equityHighMilli : equityEnd;
    const equityLow = acct.equityLowMilli != null ? acct.equityLowMilli : equityEnd;

    const events = engine.store?.loadRuleEvents?.(userId, since, until) ?? [];
    const triggers = events.map((e) => ({
      rule_id: e.ruleId,
      kind: e.kind,
      tick_id: e.tickId,
      side: e.side ?? null,
      price_e4: e.priceE4 ?? null,
      notional_milli: e.notionalMilli ?? null,
      pnl_milli: e.pnlMilli ?? null,
      ...(e.reason ? { reason: e.reason } : {}),
    }));

    const liquidated = triggers.some((t) => t.kind === 'liquidation')
      || this.#hasLiquidation(userId, since, until);

    return {
      since_tick: since,
      until_tick: until,
      offline_seconds: span, // 1 tick = 1 秒市場時間
      income_milli: INCOME_MILLI_PER_TICK * span,
      equity_start_milli: equityStart,
      equity_end_milli: equityEnd,
      equity_high_milli: equityHigh,
      equity_low_milli: equityLow,
      liquidated,
      triggers,
    };
  }

  /** 期間內是否發生強平（含玩家手動部位的強平） */
  #hasLiquidation(userId, since, until) {
    const trades = this.engine.store?.loadTradesRange?.(userId, since, until) ?? [];
    return trades.some((t) => t.kind === 'liquidate');
  }
}

export default ReportService;
