/**
 * 離線自動規則引擎（M3，spec §6.3 ＋ contract「Rule semantics」）。
 *
 * 目前只有一種規則：**條件開倉**（`conditional_open`）。
 *
 * 語意要點（contract）：
 *   - 一次性：成功成交後 → `status='triggered'`，永不再次觸發（已觸發不佔 2 條額度）。
 *   - 每帳號最多 **2 條啟用中**（`status='active'`）的條件開倉規則。
 *   - 觸發判定：tick 的 last price **碰到**觸發價；方向由建立時的 `armed_side` 決定
 *     （`above` = 觸發價在現價之上 → `price >= trigger`；`below` → `price <= trigger`）。
 *   - 成交在**下一 tick**：以成交 tick 的市價成交，**0.1% 滑價只在變差時加**
 *     （買：next > trigger → ×1.001；賣：next < trigger → ×0.999）。
 *   - 成交失敗（餘額不足／持倉滿／欠款…）→ **不自動停用**：回到 `active` + `last_error`，
 *     同一規則每 5 分鐘（300 ticks）最多通知一次。
 *   - 強平 → 暫停（`paused` + `paused_reason='liquidation'`）該使用者的所有啟用中規則，
 *     需手動重新啟用。
 *   - 每 tick 執行順序：強平 → 停損／停利 → 規則成交；觸發判定用本 tick 的 last price。
 *
 * 時間一律用 `tick_id`（經濟時間），不使用 wall clock（§5.4）。
 */

import {
  DEFAULT_LEVERAGE,
  LEVERAGE_OPTIONS,
  MARGIN_STEP_A,
  MAX_ACTIVE_RULES,
  MILLI_PER_A,
  RULE_KIND,
  RULE_NOTIFY_COOLDOWN_TICKS,
  RULE_SLIPPAGE,
  RULE_TRIGGER_TOO_CLOSE,
} from './config.js';
import { minMarginForLeverage, liquidationDistance } from './account.js';
import { priceToE4 } from './money.js';
import { parseStopPrice, pctOnlyGiven, resolveStops } from './stops.js';

/** 規則狀態（contract：`active|paused|triggered|cancelled`） */
export const RULE_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  TRIGGERED: 'triggered',
  CANCELLED: 'cancelled',
});

/**
 * 穩定原因字串（contract 列舉 + 本實作延伸）。
 * 建立類：`max_active_rules` `trigger_too_close` `invalid_trigger` `invalid_margin`
 *          `invalid_leverage` `invalid_side` `insufficient_margin`
 * 編輯類：`not_found` `rule_not_active`（已觸發 / 已取消的規則不得重新啟用）
 */
export const RULE_REASONS = Object.freeze({
  MAX_ACTIVE: 'max_active_rules',
  TRIGGER_TOO_CLOSE: 'trigger_too_close',
  INVALID_TRIGGER: 'invalid_trigger',
  INVALID_MARGIN: 'invalid_margin',
  INVALID_LEVERAGE: 'invalid_leverage',
  INVALID_SIDE: 'invalid_side',
  INSUFFICIENT_MARGIN: 'insufficient_margin',
  NOT_FOUND: 'not_found',
  NOT_REENABLEABLE: 'rule_not_active',
  INVALID_SL: 'sl_invalid',
  INVALID_TP: 'tp_invalid',
  // 價格制：舊的百分比欄位已移除（前端舊頁面需重整）
  SL_PCT_REMOVED: 'sl_pct_removed',
  TP_PCT_REMOVED: 'tp_pct_removed',
});

/**
 * `resolveStops` 的失敗原因 → 規則的穩定原因字串。
 * `sl_invalid` / `tp_invalid` 沿用既有文案；其餘（方向錯誤 / 距離過近 / 超過強平距離）
 * 原樣回傳，讓前端能區分「錯在哪裡」。
 */
function mapStopReason(reason) {
  if (reason === 'sl_invalid') return RULE_REASONS.INVALID_SL;
  if (reason === 'tp_invalid') return RULE_REASONS.INVALID_TP;
  return reason;
}

/** 引擎的開倉失敗原因 → contract 的穩定跳過原因 */
const SKIP_REASON_MAP = Object.freeze({
  insufficient_balance: 'insufficient_balance',
  max_positions: 'max_positions',
  debt_no_open: 'debt_no_open',
  min_notional: 'invalid_margin',
  min_margin: 'invalid_margin',
  margin_invalid: 'invalid_margin',
  margin_step: 'invalid_margin',
  max_notional: 'insufficient_margin',
  side_invalid: 'invalid_side',
  leverage_invalid: 'invalid_leverage',
  sl_too_close: 'sl_too_close',
  sl_beyond_liq: 'sl_beyond_liq',
  tp_invalid: 'tp_invalid',
});

/** 規則 → API JSON（contract「Rule shape」） */
export function ruleJson(rule) {
  return {
    id: rule.id,
    kind: rule.kind,
    side: rule.side,
    trigger_price_e4: rule.triggerPriceE4,
    margin_a: rule.marginA,
    leverage: rule.leverage,
    // 價格制（使用者輸入的絕對價位）
    sl_price_e4: rule.slPriceE4 ?? null,
    tp_price_e4: rule.tpPriceE4 ?? null,
    // 舊百分比制已移除：欄位保留但恆為 null（相容舊前端文案）
    sl_pct: null,
    tp_pct: null,
    enabled: !!rule.enabled,
    status: rule.status,
    armed_side: rule.armedSide ?? null,
    created_tick: rule.createdTick ?? 0,
    triggered_tick: rule.triggeredTick ?? null,
    last_error: rule.lastError ?? null,
    paused_reason: rule.pausedReason ?? null,
  };
}

export class RuleManager {
  /**
   * @param {object} opts
   * @param {import('./engine.js').Engine} opts.engine
   */
  constructor({ engine }) {
    this.engine = engine;
    this.store = engine.store ?? null;
    this.rules = new Map(); // id → rule
    this.nextRuleId = 1;
    this._persisted = new Set();

    // 對外通知鉤子（由 live.js 接上）
    this.onRuleUpdated = null; // (userId, ruleJson) => void
    this.onRuleTriggered = null; // (userId, data) => void
    this.onRuleSkipped = null; // (userId, data) => void
  }

  // ------------------------------------------------------------ 查詢
  currentTickId() {
    return Math.max(0, this.engine.ticksExecuted - 1);
  }

  /** 某使用者的所有規則（依 id 排序） */
  listFor(userId) {
    return [...this.rules.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.id - b.id);
  }

  /** 啟用中（`status='active'`）的規則數 → 佔 2 條額度 */
  activeCount(userId) {
    return this.listFor(userId).filter((r) => r.status === RULE_STATUS.ACTIVE).length;
  }

  get(id) {
    return this.rules.get(Number(id)) ?? null;
  }

  // ------------------------------------------------------------ 持久化
  load() {
    const rows = this.store?.loadRules?.() ?? [];
    for (const row of rows) {
      this.rules.set(row.id, row);
      this._persisted.add(row.id);
      if (row.id >= this.nextRuleId) this.nextRuleId = row.id + 1;
    }
    return this;
  }

  #save(rule) {
    if (this._persisted.has(rule.id)) this.store?.updateRule?.(rule);
    else {
      this.store?.saveRule?.(rule);
      this._persisted.add(rule.id);
    }
  }

  // ------------------------------------------------------------ 建立 / 編輯 / 取消
  /**
   * 建立一條條件開倉規則。
   * @param {number} userId
   * @param {object} input { side, trigger_price_e4, margin_a, leverage, sl_price_e4?, tp_price_e4?, confirm? }
   * @param {object} meta { requestId? }（WS 請求的 request_id，會帶在 `rule.updated` 裡）
   * @returns {{ok:true, rule:object}|{ok:false, reason:string}}
   */
  createRule(userId, input = {}, meta = {}) {
    const engine = this.engine;
    const acct = engine.ensureAccount(userId);

    const side = input.side;
    if (side !== 'long' && side !== 'short') {
      return { ok: false, reason: RULE_REASONS.INVALID_SIDE };
    }

    const leverage = Number(input.leverage ?? DEFAULT_LEVERAGE);
    if (!LEVERAGE_OPTIONS.includes(leverage)) {
      return { ok: false, reason: RULE_REASONS.INVALID_LEVERAGE };
    }

    const marginA = Number(input.margin_a ?? input.marginA ?? input.margin);
    if (!Number.isFinite(marginA) || marginA <= 0) {
      return { ok: false, reason: RULE_REASONS.INVALID_MARGIN };
    }
    if (marginA % MARGIN_STEP_A !== 0) {
      return { ok: false, reason: RULE_REASONS.INVALID_MARGIN };
    }
    if (marginA < minMarginForLeverage(leverage)) {
      return { ok: false, reason: RULE_REASONS.INVALID_MARGIN };
    }

    const triggerPriceE4 = Number(input.trigger_price_e4 ?? input.triggerPriceE4);
    if (!Number.isInteger(triggerPriceE4) || triggerPriceE4 <= 0) {
      return { ok: false, reason: RULE_REASONS.INVALID_TRIGGER };
    }

    // 停損 / 停利：**價格制**（整數 e4 價位）；舊的百分比欄位已移除
    const slPriceRaw = input.sl_price_e4 ?? input.slPriceE4;
    const tpPriceRaw = input.tp_price_e4 ?? input.tpPriceE4;
    if (pctOnlyGiven(input.sl_pct ?? input.slPct, slPriceRaw)) {
      return { ok: false, reason: RULE_REASONS.SL_PCT_REMOVED };
    }
    if (pctOnlyGiven(input.tp_pct ?? input.tpPct, tpPriceRaw)) {
      return { ok: false, reason: RULE_REASONS.TP_PCT_REMOVED };
    }
    const slParsed = parseStopPrice(slPriceRaw);
    if (slParsed.error) return { ok: false, reason: RULE_REASONS.INVALID_SL };
    const tpParsed = parseStopPrice(tpPriceRaw);
    if (tpParsed.error) return { ok: false, reason: RULE_REASONS.INVALID_TP };

    // 驗證基準：**參考價 = 規則的觸發價**（建立／修改時都用它）
    const stops = resolveStops({
      slPriceE4: slParsed.value,
      tpPriceE4: tpParsed.value,
      side,
      refPriceE4: triggerPriceE4,
      liqDist: liquidationDistance(leverage),
    });
    if (!stops.ok) return { ok: false, reason: mapStopReason(stops.reason) };

    const priceE4 = priceToE4(engine.market.price);
    // 觸發價已在現價（或差 < 0.05%）→ UI 警告「會立刻成交」，伺服器預設拒絕；
    // 玩家確認後可帶 `confirm: true` 建立。
    const dist = Math.abs(triggerPriceE4 - priceE4) / priceE4;
    const confirmed = input.confirm === true || input.confirm === 'true';
    if (dist < RULE_TRIGGER_TOO_CLOSE && !confirmed) {
      return { ok: false, reason: RULE_REASONS.TRIGGER_TOO_CLOSE };
    }

    if (this.activeCount(userId) >= MAX_ACTIVE_RULES) {
      return { ok: false, reason: RULE_REASONS.MAX_ACTIVE };
    }

    // 餘額檢查（建立當下就要能負擔保證金）
    const available = acct.availableMilli(engine.ticksExecuted);
    const marginMilli = Math.round(marginA * MILLI_PER_A);
    if (acct.balanceMilli < 0 || marginMilli > available) {
      return { ok: false, reason: RULE_REASONS.INSUFFICIENT_MARGIN };
    }

    const rule = {
      id: this.nextRuleId++,
      userId,
      kind: RULE_KIND,
      side,
      triggerPriceE4,
      marginA,
      leverage,
      // **價格制**：使用者輸入的絕對價位（e4 整數），原樣儲存、成交時原樣帶入
      slPriceE4: stops.slPriceE4,
      tpPriceE4: stops.tpPriceE4,
      // 舊百分比制已移除 → 恆為 null
      slPct: null,
      tpPct: null,
      enabled: true,
      status: RULE_STATUS.ACTIVE,
      armedSide: triggerPriceE4 > priceE4 ? 'above' : 'below',
      createdTick: this.currentTickId(),
      triggeredTick: null,
      lastError: null,
      pausedReason: null,
      lastNotifiedTick: null,
      pendingTick: null,
      positionId: null,
      params: {
        side,
        trigger_price_e4: triggerPriceE4,
        margin_a: marginA,
        leverage,
        sl_price_e4: stops.slPriceE4,
        tp_price_e4: stops.tpPriceE4,
      },
    };

    this.rules.set(rule.id, rule);
    this.#save(rule);
    this.#notifyUpdated(rule, meta);
    return { ok: true, rule };
  }

  /**
   * 編輯規則（啟用／停用 或 改參數）。
   * @param {object} patch { enabled?, side?, trigger_price_e4?, margin_a?, leverage?, sl_price_e4?, tp_price_e4? }
   */
  updateRule(userId, id, patch = {}, meta = {}) {
    const rule = this.get(id);
    if (!rule || rule.userId !== userId) return { ok: false, reason: RULE_REASONS.NOT_FOUND };
    if (rule.status === RULE_STATUS.TRIGGERED || rule.status === RULE_STATUS.CANCELLED) {
      return { ok: false, reason: RULE_REASONS.NOT_REENABLEABLE };
    }

    // ---- 啟用 / 停用 ----
    if (patch.enabled !== undefined) {
      const enabled = patch.enabled === true || patch.enabled === 'true';
      if (enabled) {
        if (rule.status !== RULE_STATUS.ACTIVE && this.activeCount(userId) >= MAX_ACTIVE_RULES) {
          return { ok: false, reason: RULE_REASONS.MAX_ACTIVE };
        }
        rule.status = RULE_STATUS.ACTIVE;
        rule.pausedReason = null;
        rule.lastError = null;
        rule.enabled = true;
      } else {
        rule.status = RULE_STATUS.PAUSED;
        rule.pausedReason = 'manual';
        rule.enabled = false;
        rule.pendingTick = null;
      }
    }

    // ---- 參數 ----
    // 舊百分比欄位：只要 patch 帶了 pct 又沒帶對應價格 → 明確拒絕（舊頁面需重整）
    if (patch.sl_price_e4 === undefined && (patch.sl_pct ?? patch.slPct) != null) {
      return { ok: false, reason: RULE_REASONS.SL_PCT_REMOVED };
    }
    if (patch.tp_price_e4 === undefined && (patch.tp_pct ?? patch.tpPct) != null) {
      return { ok: false, reason: RULE_REASONS.TP_PCT_REMOVED };
    }

    const hasParams = ['side', 'trigger_price_e4', 'margin_a', 'leverage', 'sl_price_e4', 'tp_price_e4']
      .some((k) => patch[k] !== undefined);
    if (hasParams) {
      const engine = this.engine;
      const side = patch.side ?? rule.side;
      if (side !== 'long' && side !== 'short') {
        return { ok: false, reason: RULE_REASONS.INVALID_SIDE };
      }
      const leverage = Number(patch.leverage ?? rule.leverage);
      if (!LEVERAGE_OPTIONS.includes(leverage)) {
        return { ok: false, reason: RULE_REASONS.INVALID_LEVERAGE };
      }
      const marginA = Number(patch.margin_a ?? rule.marginA);
      if (!Number.isFinite(marginA) || marginA <= 0 || marginA % MARGIN_STEP_A !== 0) {
        return { ok: false, reason: RULE_REASONS.INVALID_MARGIN };
      }
      if (marginA < minMarginForLeverage(leverage)) {
        return { ok: false, reason: RULE_REASONS.INVALID_MARGIN };
      }
      const triggerPriceE4 = Number(patch.trigger_price_e4 ?? rule.triggerPriceE4);
      if (!Number.isInteger(triggerPriceE4) || triggerPriceE4 <= 0) {
        return { ok: false, reason: RULE_REASONS.INVALID_TRIGGER };
      }
      // 價格制：patch 沒帶 → 沿用規則上的價格；明確帶 null → 清除
      const slRaw = patch.sl_price_e4 !== undefined ? patch.sl_price_e4 : rule.slPriceE4;
      const tpRaw = patch.tp_price_e4 !== undefined ? patch.tp_price_e4 : rule.tpPriceE4;
      const slParsed = parseStopPrice(slRaw);
      if (slParsed.error) return { ok: false, reason: RULE_REASONS.INVALID_SL };
      const tpParsed = parseStopPrice(tpRaw);
      if (tpParsed.error) return { ok: false, reason: RULE_REASONS.INVALID_TP };
      const stops = resolveStops({
        slPriceE4: slParsed.value,
        tpPriceE4: tpParsed.value,
        side,
        refPriceE4: triggerPriceE4,
        liqDist: liquidationDistance(leverage),
      });
      if (!stops.ok) return { ok: false, reason: mapStopReason(stops.reason) };

      const priceE4 = priceToE4(engine.market.price);
      const dist = Math.abs(triggerPriceE4 - priceE4) / priceE4;
      const confirmed = patch.confirm === true || patch.confirm === 'true';
      if (dist < RULE_TRIGGER_TOO_CLOSE && !confirmed) {
        return { ok: false, reason: RULE_REASONS.TRIGGER_TOO_CLOSE };
      }

      rule.side = side;
      rule.leverage = leverage;
      rule.marginA = marginA;
      rule.triggerPriceE4 = triggerPriceE4;
      rule.slPriceE4 = stops.slPriceE4;
      rule.tpPriceE4 = stops.tpPriceE4;
      rule.slPct = null;
      rule.tpPct = null;
      rule.armedSide = triggerPriceE4 > priceE4 ? 'above' : 'below';
      rule.params = {
        side,
        trigger_price_e4: triggerPriceE4,
        margin_a: marginA,
        leverage,
        sl_price_e4: rule.slPriceE4,
        tp_price_e4: rule.tpPriceE4,
      };
      // 參數改變 → 重新武裝
      rule.pendingTick = null;
      rule.triggeredTick = null;
      rule.lastError = null;
    }

    this.#save(rule);
    this.#notifyUpdated(rule, meta);
    return { ok: true, rule };
  }

  /** 取消規則（DELETE /api/rules/:id） */
  cancelRule(userId, id, meta = {}) {
    const rule = this.get(id);
    if (!rule || rule.userId !== userId) return { ok: false, reason: RULE_REASONS.NOT_FOUND };
    if (rule.status === RULE_STATUS.CANCELLED) return { ok: true, rule };
    rule.status = RULE_STATUS.CANCELLED;
    rule.enabled = false;
    rule.pendingTick = null;
    this.#save(rule);
    this.#notifyUpdated(rule, meta);
    return { ok: true, rule };
  }

  // ------------------------------------------------------------ 每 tick 處理
  /**
   * 每個 tick 呼叫一次（引擎在「強平 → 停損停利」之後呼叫）。
   *
   * 順序：
   *   1) **觸發判定**：用本 tick 的 last price 判定，觸發者排入「下一 tick 成交」。
   *   2) **成交**：上一 tick 觸發的規則在本 tick 以本 tick 的市價成交。
   *      （先判定後成交 → 成交失敗時規則的狀態會停在 `active`＋`last_error`，
   *        下一個 tick 才會再次被觸發，符合 contract「失敗 → 回到 active」。）
   *
   * @param {number} tickId 本 tick 的 tick_id（0-based，與 API 的 `tick_id` 同一時鐘）
   */
  processTick(tickId) {
    // 1) 觸發判定：用本 tick 的 last price
    const price = this.engine.market.price;
    for (const rule of this.listForAll()) {
      if (rule.status !== RULE_STATUS.ACTIVE) continue;
      if (rule.pendingTick != null) continue;
      if (!this.#touches(rule, price)) continue;
      rule.status = RULE_STATUS.TRIGGERED;
      rule.triggeredTick = tickId;
      rule.pendingTick = tickId + 1; // 下一 tick 成交
      rule.lastError = null;
      this.#save(rule);
      this.#notifyUpdated(rule);
    }

    // 2) 成交：上一 tick 觸發的規則在本 tick 成交
    for (const rule of this.listForAll()) {
      if (rule.pendingTick == null) continue;
      if (rule.pendingTick > tickId) continue;
      if (rule.status !== RULE_STATUS.TRIGGERED) {
        // 已被暫停／取消 → 丟棄這次觸發
        rule.pendingTick = null;
        this.#save(rule);
        continue;
      }
      this.#fillRule(rule, tickId);
    }
  }

  /** 全部規則（依 id 排序） */
  listForAll() {
    return [...this.rules.values()].sort((a, b) => a.id - b.id);
  }

  /** 觸發判定：last price 碰到觸發價（方向由 `armed_side` 決定） */
  #touches(rule, price) {
    const priceE4 = priceToE4(price);
    if (rule.armedSide === 'above') return priceE4 >= rule.triggerPriceE4;
    return priceE4 <= rule.triggerPriceE4;
  }

  /**
   * 成交（在觸發的**下一 tick**執行）。
   * 成交價 = 成交 tick 的市價，**0.1% 滑價只在變差時加**。
   */
  #fillRule(rule, tickId) {
    const engine = this.engine;
    const price = engine.market.price;
    const priceE4 = priceToE4(price);

    let fillPriceE4;
    if (rule.side === 'long') {
      fillPriceE4 = priceE4 > rule.triggerPriceE4
        ? priceToE4(price * (1 + RULE_SLIPPAGE))
        : priceE4;
    } else {
      fillPriceE4 = priceE4 < rule.triggerPriceE4
        ? priceToE4(price * (1 - RULE_SLIPPAGE))
        : priceE4;
    }

    const result = engine.openRulePosition(rule.userId, rule, fillPriceE4);

    if (!result.ok) {
      // 失敗：不自動停用 → 回到 active + last_error（每 5 分鐘最多通知一次）
      const reason = SKIP_REASON_MAP[result.reason] ?? result.reason ?? 'unknown';
      rule.status = RULE_STATUS.ACTIVE;
      rule.pendingTick = null;
      rule.triggeredTick = null;
      rule.lastError = reason;
      this.#save(rule);
      // 只有「真的通知玩家」時才寫 rule_events（避免每 tick 一筆的寫入雜訊）
      if (this.#notifySkipped(rule, reason, tickId)) {
        this.#recordEvent(rule, 'skipped', tickId, {
          priceE4: fillPriceE4,
          reason,
        });
      }
      this.#notifyUpdated(rule);
      return;
    }

    // 成功：一次性 → 觸發後結束
    rule.status = RULE_STATUS.TRIGGERED;
    rule.pendingTick = null;
    rule.lastError = null;
    rule.positionId = result.position.id;
    this.#save(rule);

    this.#recordEvent(rule, 'open', tickId, {
      priceE4: result.position.entryPriceE4,
      notionalMilli: result.position.notionalMilli,
      pnlMilli: null,
    });
    if (this.onRuleTriggered) {
      this.onRuleTriggered(rule.userId, {
        rule_id: rule.id,
        position_id: result.position.id,
        side: rule.side,
        fill_price_e4: result.position.entryPriceE4,
        notional_milli: result.position.notionalMilli,
      });
    }
    this.#notifyUpdated(rule);

    // 規則開倉的 SL 以成交價重算；若成交價已穿過 SL → 立刻平倉
    if (result.closedImmediately && result.closeResult?.ok) {
      const closed = result.closeResult;
      this.#recordEvent(rule, 'sl', tickId, {
        priceE4: closed.exitPriceE4,
        notionalMilli: closed.position.notionalMilli,
        pnlMilli: closed.pnlMilli,
      });
    }
  }

  // ------------------------------------------------------------ 強平 / 停損停利
  /**
   * 強平：暫停該使用者所有啟用中的規則（需手動重新啟用）。
   * @param {object} r closePosition 的結果（含 position）
   */
  handleLiquidation(r) {
    const position = r?.position;
    if (!position) return;
    const tickId = position.closedAt ?? this.currentTickId();

    if (position.ruleId != null) {
      const rule = this.get(position.ruleId);
      if (rule) {
        this.#recordEvent(rule, 'liquidation', tickId, {
          priceE4: r.exitPriceE4,
          notionalMilli: position.notionalMilli,
          pnlMilli: r.pnlMilli,
        });
      }
    }

    this.pauseRules(position.userId, 'liquidation');
  }

  /**
   * 停損／停利平倉（僅記錄由規則開出的部位）。
   * @param {object} r closePosition 的結果（含 stopKind: 'sl' | 'tp'）
   */
  handleStopClosed(r) {
    const position = r?.position;
    if (!position || position.ruleId == null) return;
    const rule = this.get(position.ruleId);
    if (!rule) return;
    const kind = r.stopKind === 'tp' ? 'tp' : 'sl';
    this.#recordEvent(rule, kind, position.closedAt ?? this.currentTickId(), {
      priceE4: r.exitPriceE4,
      notionalMilli: position.notionalMilli,
      pnlMilli: r.pnlMilli,
    });
  }

  /** 暫停某使用者的所有啟用中規則 */
  pauseRules(userId, reason) {
    for (const rule of this.listFor(userId)) {
      if (rule.status !== RULE_STATUS.ACTIVE) continue;
      rule.status = RULE_STATUS.PAUSED;
      rule.pausedReason = reason;
      rule.pendingTick = null;
      this.#save(rule);
      this.#notifyUpdated(rule);
    }
  }

  // ------------------------------------------------------------ 內部
  #recordEvent(rule, kind, tickId, { priceE4 = null, notionalMilli = null, pnlMilli = null, reason = null } = {}) {
    const ev = {
      userId: rule.userId,
      ruleId: rule.id,
      kind,
      tickId,
      side: rule.side,
      priceE4,
      notionalMilli,
      pnlMilli,
      reason,
    };
    this.store?.saveRuleEvent?.(ev);
    return ev;
  }

  #notifyUpdated(rule, meta = {}) {
    if (this.onRuleUpdated) this.onRuleUpdated(rule.userId, ruleJson(rule), meta);
  }

  /** 通知玩家「這條規則跳過了」；同一規則 5 分鐘內最多一次。@returns {boolean} 是否真的通知 */
  #notifySkipped(rule, reason, tickId) {
    const last = rule.lastNotifiedTick;
    if (last != null && tickId - last < RULE_NOTIFY_COOLDOWN_TICKS) return false; // 5 分鐘內不重複通知
    rule.lastNotifiedTick = tickId;
    this.#save(rule);
    if (this.onRuleSkipped) {
      this.onRuleSkipped(rule.userId, { rule_id: rule.id, reason });
    }
    return true;
  }
}

export default RuleManager;
