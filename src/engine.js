/**
 * Tick 協調器（spec §4.4 / §5.4）。
 *
 * 每個 tick 的順序（固定、決定性）：
 *   1. tick_count += 1（tick_id 是唯一真相，不看 wall clock）
 *   2. 市場推進：事件排程 + OU（記錄價格到當分鐘 K 線）
 *   3. 整點持倉費（tick_count % 3600 === 0）
 *   4. 停損 / 停利
 *   5. 強平（先收集全部觸發，再依序平倉並重算價格）
 *   6. 分鐘收線：封存 candles_1m + 引擎狀態（tick_id 隨 K 線持久化）
 *
 * 收入採「延遲結算」：balance_milli 只在需要時（結算時）把
 * 35,000 × (tick_count − settled_tick_id) 併進去。
 */

import {
  DEFAULT_LEVERAGE,
  DEFAULT_SEED,
  DEFAULT_USER_ID,
  DT,
  INITIAL_BALANCE_MILLI,
  LEVERAGE_OPTIONS,
  MARGIN_STEP_A,
  MAX_ORDER_NOTIONAL_MULTIPLE,
  MAX_USER_NOTIONAL_MULTIPLE,
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
  MILLI_PER_A,
} from './config.js';
import { Account, Position } from './account.js';
import { Market } from './market.js';
import { Rng } from './rng.js';
import { createMemoryStore } from './db.js';
import { priceToE4 } from './money.js';
import { RuleManager } from './rules.js';
import { ReportService } from './report.js';

const SETTLE_EVERY_TICKS = TICKS_PER_MINUTE * 5; // §5.4：每 5 分鐘結算一次

/**
 * DB row（snake_case 欄位）或記憶體 store 的 Position 物件（camelCase）→ Position。
 * §6.2 v0.25：經濟時間欄位在 DB 為 tick_id（opened_tick / closed_tick）。
 */
function rowToPosition(row) {
  return new Position({
    id: row.id,
    userId: row.user_id ?? row.userId,
    side: row.side,
    notionalMilli: row.notional_milli ?? row.notionalMilli,
    leverage: row.leverage,
    marginMilli: row.margin_milli ?? row.marginMilli,
    entryPriceE4: row.entry_price_e4 ?? row.entryPriceE4,
    liqPriceE4: row.liq_price_e4 ?? row.liqPriceE4,
    slPriceE4: row.sl_price_e4 ?? row.slPriceE4 ?? null,
    tpPriceE4: row.tp_price_e4 ?? row.tpPriceE4 ?? null,
    feeRemainderMicro: row.fee_remainder_micro ?? row.feeRemainderMicro ?? 0,
    status: row.status,
    openedAt: row.opened_tick ?? row.openedAt ?? 0,
    closedAt: row.closed_tick ?? row.closedAt ?? null,
    closePriceE4: row.close_price_e4 ?? row.closePriceE4 ?? null,
    pnlMilli: row.pnl_milli ?? row.pnlMilli ?? 0,
  });
}

export class Engine {
  constructor({ seed = DEFAULT_SEED, store = null, userId = DEFAULT_USER_ID } = {}) {
    this.seed = seed >>> 0;
    this.store = store ?? createMemoryStore();
    this.userId = userId;
    this.rng = new Rng(this.seed);
    this.market = new Market({ rng: this.rng });
    this.accounts = new Map();
    this.ticksExecuted = 0;
    this.candle = null;
    this.nextPositionId = 1;
    this.nextTradeId = 1;
    this.nextLedgerId = 1;
    this.nextEventId = 1;
    this.lastClosedMinuteId = -1;
    this.pendingVolumeMilli = 0;
    this._savedPositionIds = new Set();
    this._loading = false;
    this._restoredFromState = false;

    // M3：離線自動規則引擎（§6.3）與離線報告（§6.4）
    this.rules = new RuleManager({ engine: this });
    this.reports = new ReportService({ engine: this });

    // M2：對外通知用的鉤子（不參與任何經濟計算，只負責「把已發生的結果通知出去」）
    //   onEvent(event)          → 新事件（payload 已濾掉 type / permanent_share）
    //   onLiquidation(info)     → 強平（user_id / position_id / price_e4 / pnl_milli）
    //   onPositionClosed(info)  → 停損停利平倉（kind: 'stop'）
    this.onEvent = null;
    this.onLiquidation = null;
    this.onPositionClosed = null;

    this.market.onPriceChange = (price, basePrice) => this.#recordPrice(price, basePrice);
    this.market.onEvent = (ev) => this.#persistEvent(ev);
  }

  // ------------------------------------------------------------ 帳號
  ensureAccount(userId = this.userId, { balanceMilli = INITIAL_BALANCE_MILLI } = {}) {
    let acct = this.accounts.get(userId);
    if (!acct) {
      acct = new Account({ userId, balanceMilli, settledTickId: this.ticksExecuted });
      this.accounts.set(userId, acct);
      this.#wireAccount(acct);
    }
    return acct;
  }

  /** 情境 / 測試用：把某帳號重置為乾淨狀態（清空持倉、給固定本金） */
  resetAccount(userId = this.userId, balanceMilli = INITIAL_BALANCE_MILLI) {
    const acct = this.ensureAccount(userId);
    acct.positions.clear();
    acct.balanceMilli = balanceMilli;
    acct.settledTickId = this.ticksExecuted;
    return acct;
  }

  /** 建立預設帳號（首次啟動） */
  init() {
    const existing = this.store.loadAccounts?.() ?? [];
    const found = existing.find((a) => (a.user_id ?? a.userId) === this.userId);
    if (!found) {
      this.store.saveUser?.({ id: this.userId, created_at: this.ticksExecuted });
      this.store.saveAccount?.({
        user_id: this.userId,
        balance_milli: INITIAL_BALANCE_MILLI,
        settled_tick_id: this.ticksExecuted,
        last_settled_tick: this.ticksExecuted,
        created_at: this.ticksExecuted,
      });
    }
    const acct = this.ensureAccount(this.userId, {
      balanceMilli: found ? (found.balance_milli ?? 0) : INITIAL_BALANCE_MILLI,
    });
    // 引擎狀態（engine_state 表）比 accounts 表新：只有沒從狀態還原時才用 accounts 表的結算點
    if (found && !this._restoredFromState) {
      acct.settledTickId = found.settled_tick_id ?? 0;
    }
    return acct;
  }

  #wireAccount(acct) {
    acct.onTrade = (t) => {
      this.store.saveTrade({ id: this.nextTradeId++, ...t });
      // §4.1：24h 名目成交量 = 開倉與平倉都計
      this.#addVolume(t.notionalMilli);
    };
    acct.onLedger = (l) => {
      this.store.saveLedger({ id: this.nextLedgerId++, ...l });
      this.store.saveAccount?.({
        user_id: acct.userId,
        balance_milli: acct.balanceMilli,
        settled_tick_id: acct.settledTickId,
        last_settled_tick: acct.settledTickId,
        created_at: 0,
      });
    };
    acct.onPositionUpdate = (p) => {
      if (this._savedPositionIds.has(p.id)) {
        this.store.updatePosition(p);
      } else {
        this._savedPositionIds.add(p.id);
        this.store.savePosition(p);
      }
      this.store.saveAccount?.({
        user_id: acct.userId,
        balance_milli: acct.balanceMilli,
        settled_tick_id: acct.settledTickId,
        last_settled_tick: acct.settledTickId,
        created_at: 0,
      });
    };
  }

  // ------------------------------------------------------------ 存取
  /** 從 store 還原狀態（§4.4） */
  load() {
    this._loading = true;
    try {
      const state = this.store.loadEngineState?.() ?? null;
      if (state) {
        this._restoredFromState = true;
        this.ticksExecuted = state.ticksExecuted ?? 0;
        this.seed = state.seed ?? this.seed;
        this.rng.setState(state.rngState ?? this.rng.getState());
        this.market.fromJSON(state.market);
        this.nextPositionId = state.nextPositionId ?? 1;
        this.nextTradeId = state.nextTradeId ?? 1;
        this.nextLedgerId = state.nextLedgerId ?? 1;
        this.nextEventId = state.nextEventId ?? 1;
        this.lastClosedMinuteId = state.lastClosedMinuteId ?? -1;
        this.pendingVolumeMilli = state.pendingVolumeMilli ?? 0;
        for (const a of state.accounts ?? []) {
          const acct = new Account({
            userId: a.userId,
            balanceMilli: a.balanceMilli,
            settledTickId: a.settledTickId,
          });
          this.accounts.set(a.userId, acct);
          this.#wireAccount(acct);
        }
      } else {
        // 沒有引擎狀態 → 從最後一根 1 分 K 線推回 tick（§5.4：tick_id 不可歸零）
        const last = this.store.loadLastCandle?.();
        if (last) {
          this.ticksExecuted = (last.minute_id + 1) * TICKS_PER_MINUTE;
          this.lastClosedMinuteId = last.minute_id;
          this.market.mu = Math.log(last.base_close_e4 / 10000);
          this.market.x = 0;
          this.market.components = [];
          this.market.recomputePrice();
        }
      }

      // 還原未平倉部位並重建全服淨部位
      const rows = this.store.loadPositions?.('open') ?? [];
      const dbAccounts = new Map(
        (this.store.loadAccounts?.() ?? []).map((a) => [a.user_id ?? a.userId, a]),
      );
      // M3：還原離線報告用的帳號 metadata（last_seen_tick / 期間淨值高低點）
      for (const [userId, rec] of dbAccounts) {
        const acct = this.ensureAccount(userId);
        acct.lastSeenTick = rec.last_seen_tick ?? rec.lastSeenTick ?? 0;
        acct.equityHighMilli = rec.equity_high_milli ?? rec.equityHighMilli ?? null;
        acct.equityLowMilli = rec.equity_low_milli ?? rec.equityLowMilli ?? null;
        acct.equitySeenMilli = rec.equity_seen_milli ?? rec.equitySeenMilli ?? null;
      }
      let net = 0;
      for (const row of rows) {
        const pos = rowToPosition(row);
        this._savedPositionIds.add(pos.id);
        if (!this.accounts.has(pos.userId)) {
          // 帳號不在引擎狀態裡（可能剛開倉就當機）→ 退回 accounts 表的餘額
          const rec = dbAccounts.get(pos.userId);
          this.ensureAccount(pos.userId, {
            balanceMilli: rec ? (rec.balance_milli ?? 0) : INITIAL_BALANCE_MILLI,
          });
          if (rec) this.accounts.get(pos.userId).settledTickId = rec.settled_tick_id ?? 0;
        }
        const acct = this.ensureAccount(pos.userId);
        acct.positions.set(pos.id, pos);
        net += pos.isLong ? pos.notionalMilli : -pos.notionalMilli;
        if (pos.id >= this.nextPositionId) this.nextPositionId = pos.id + 1;
      }
      if (net !== 0) this.market.setNetNotional(net / MILLI_PER_A);
      else this.market.recomputePrice();

      // M3：還原自動規則（§6.3）
      this.rules.load();
    } finally {
      this._loading = false;
    }
    return this;
  }

  /** 序列化引擎狀態（存進 engine_state 表，供重啟還原） */
  serializeState() {
    return {
      ticksExecuted: this.ticksExecuted,
      seed: this.seed,
      rngState: this.rng.getState(),
      market: this.market.toJSON(),
      nextPositionId: this.nextPositionId,
      nextTradeId: this.nextTradeId,
      nextLedgerId: this.nextLedgerId,
      nextEventId: this.nextEventId,
      lastClosedMinuteId: this.lastClosedMinuteId,
      pendingVolumeMilli: this.pendingVolumeMilli,
      accounts: [...this.accounts.values()].map((a) => a.toJSON()),
    };
  }

  // ------------------------------------------------------------ tick
  /** 推進 n 個 tick */
  tick(count = 1) {
    for (let i = 0; i < count; i++) this.tickOnce();
    return this.ticksExecuted;
  }

  tickOnce() {
    this.ticksExecuted += 1;
    const tickId = this.ticksExecuted - 1;

    // 1) 市場：事件 + OU
    this.market.step(DT, tickId);

    // 2) 整點持倉費（先收，再強平：持到整點就該付那一小時）
    if (this.ticksExecuted % TICKS_PER_HOUR === 0) {
      for (const acct of this.accounts.values()) {
        acct.chargeHourlyFees(this.ticksExecuted);
      }
    }

    // 3) 強平（先收集全部觸發 → 再依序平倉並重算價格）
    //    §6.3：每 tick 的執行順序為「強平 → 停損／停利 → 條件開倉」
    for (const acct of this.accounts.values()) {
      const liquidations = acct.liquidateIfNeeded({ market: this.market, tickCount: this.ticksExecuted });
      for (const r of liquidations) {
        // M3：強平 → 暫停該使用者的所有啟用中規則（§6.3）
        this.rules.handleLiquidation(r);
        this.#notifyLiquidated(r);
      }
    }

    // 4) 停損 / 停利
    for (const acct of this.accounts.values()) {
      const stopped = acct.checkStopOrders({ market: this.market, tickCount: this.ticksExecuted });
      for (const r of stopped) {
        // M3：記錄規則開出的部位被停損／停利平倉（離線報告用）
        this.rules.handleStopClosed(r);
        this.#notifyPositionClosed(r, 'stop');
      }
    }

    // 5) M3：條件開倉規則（成交上一 tick 觸發的 → 再以本 tick 的 last price 判定觸發）
    this.rules.processTick(tickId);

    // 6) 期間淨值高低點（離線報告 §6.4）
    this.#trackEquity();

    // 7) 分鐘收線
    if (this.ticksExecuted % TICKS_PER_MINUTE === 0) {
      this.#closeMinute();
    }
    return this.ticksExecuted;
  }

  /** 手動觸發一次強平檢查（情境 / 測試用） */
  runLiquidations() {
    const results = [];
    for (const acct of this.accounts.values()) {
      const r = acct.liquidateIfNeeded({ market: this.market, tickCount: this.ticksExecuted });
      results.push(...r);
    }
    return results;
  }

  /** 立刻把引擎狀態寫進 store（CLI 每次結束前呼叫） */
  persist() {
    this.store.saveEngineState?.(this.serializeState());
    return this;
  }

  /** 單筆可開的最大名目（min(2L, 可用×槓桿, 單人 4L 餘額)） */
  maxOpenNotional(userId = this.userId, leverage = DEFAULT_LEVERAGE) {
    const acct = this.ensureAccount(userId);
    const available = acct.availableMilli(this.ticksExecuted);
    const maxByLiquidity = Math.floor(MAX_ORDER_NOTIONAL_MULTIPLE * this.market.L * MILLI_PER_A);
    const maxByBalance = available * leverage;
    const userTotal = acct.openPositions().reduce((s, p) => s + p.notionalMilli, 0);
    const room = Math.max(
      0,
      Math.floor(MAX_USER_NOTIONAL_MULTIPLE * this.market.L * MILLI_PER_A) - userTotal,
    );
    const cap = Math.min(maxByLiquidity, maxByBalance, room);
    const step = MARGIN_STEP_A * leverage * MILLI_PER_A;
    const notionalMilli = Math.floor(cap / step) * step;
    return { notionalMilli, marginA: notionalMilli / leverage / MILLI_PER_A };
  }

  /** 人工注入跳空（測試 / 情境用） */
  applyShock(ret) {
    const price = this.market.applyShock(ret);
    this.#recordPrice(price, this.market.basePrice);
    return price;
  }

  // ------------------------------------------------------------ 交易
  open(userId = this.userId, params = {}) {
    const acct = this.ensureAccount(userId);
    const {
      side = 'long',
      marginA = 1000,
      leverage = DEFAULT_LEVERAGE,
      slPct = null,
      tpPct = null,
    } = params;
    const result = acct.openPosition({
      side,
      marginA,
      leverage,
      slPct,
      tpPct,
      market: this.market,
      tickCount: this.ticksExecuted,
      positionId: this.nextPositionId,
    });
    if (result.ok) {
      this.nextPositionId += 1;
      this.store.saveAccount?.({
        user_id: userId,
        balance_milli: acct.balanceMilli,
        settled_tick_id: acct.settledTickId,
        last_settled_tick: acct.settledTickId,
        created_at: 0,
      });
    }
    return result;
  }

  close(userId = this.userId, positionId) {
    const acct = this.ensureAccount(userId);
    const result = acct.closePosition({
      positionId: Number(positionId),
      market: this.market,
      tickCount: this.ticksExecuted,
      reason: 'manual',
      status: 'closed',
    });
    if (result.ok) {
      this.store.saveAccount?.({
        user_id: userId,
        balance_milli: acct.balanceMilli,
        settled_tick_id: acct.settledTickId,
        last_settled_tick: acct.settledTickId,
        created_at: 0,
      });
    }
    return result;
  }

  // ------------------------------------------------------------ M3 規則
  /**
   * 規則成交（§6.3）：以**已含 0.1% 滑價**的成交價開倉，SL/TP 由成交價重算。
   * @param {number} userId
   * @param {object} rule 規則物件
   * @param {number} fillPriceE4 成交價（e4 整數）
   */
  openRulePosition(userId, rule, fillPriceE4) {
    const acct = this.ensureAccount(userId);
    const result = acct.openPosition({
      side: rule.side,
      marginA: rule.marginA,
      leverage: rule.leverage,
      slPct: rule.slPct != null ? rule.slPct / 100 : null,
      tpPct: rule.tpPct != null ? rule.tpPct / 100 : null,
      market: this.market,
      tickCount: this.ticksExecuted,
      positionId: this.nextPositionId,
      fillPriceE4,
      ruleId: rule.id,
    });
    if (result.ok) {
      this.nextPositionId += 1;
      this.store.saveAccount?.({
        user_id: userId,
        balance_milli: acct.balanceMilli,
        settled_tick_id: acct.settledTickId,
        last_settled_tick: acct.settledTickId,
        created_at: 0,
      });
    }
    return result;
  }

  /** 寫回帳號的離線報告 metadata（last_seen_tick / 期間淨值高低點） */
  persistAccountMeta(acct) {
    // store.updateAccountMeta 是 upsert（餘額一併寫回），不需要另外呼叫 saveAccount
    this.store.updateAccountMeta?.(acct.userId, {
      balanceMilli: acct.balanceMilli,
      settledTickId: acct.settledTickId,
      lastSettledTick: acct.settledTickId,
      lastSeenTick: acct.lastSeenTick ?? 0,
      equityHighMilli: acct.equityHighMilli ?? null,
      equityLowMilli: acct.equityLowMilli ?? null,
      equitySeenMilli: acct.equitySeenMilli ?? null,
    });
  }

  // ------------------------------------------------------------ 查詢
  status(userId = this.userId) {
    const acct = this.accounts.get(userId);
    if (!acct) return null;
    return {
      tickId: this.ticksExecuted - 1,
      ticksExecuted: this.ticksExecuted,
      price: this.market.price,
      basePrice: this.market.basePrice,
      impact: this.market.impactMultiplier() - 1,
      netNotionalA: this.market.netNotionalA,
      L: this.market.L,
      balanceMilli: acct.balanceMilli,
      settledTickId: acct.settledTickId,
      availableMilli: acct.availableMilli(this.ticksExecuted),
      marginMilli: acct.totalMarginMilli,
      equityMilli: acct.equityMilli(this.ticksExecuted),
      positions: acct.openPositions().map((p) => ({ ...p })),
    };
  }

  candles(limit = 60) {
    return this.store.loadCandles?.(limit) ?? [];
  }

  events(limit = 50) {
    return this.store.loadEvents?.(limit) ?? [];
  }

  trades(limit = 50) {
    return this.store.loadTrades?.(limit) ?? [];
  }

  ledger(limit = 50) {
    return this.store.loadLedger?.(limit) ?? [];
  }

  /** 全服 A 幣供給（現金 + 在場保證金） */
  totalSupplyMilli() {
    let total = 0;
    for (const acct of this.accounts.values()) total += acct.equityMilli(this.ticksExecuted);
    return total;
  }

  // ------------------------------------------------------------ 內部
  #currentMinuteId() {
    return Math.floor(Math.max(0, this.ticksExecuted - 1) / TICKS_PER_MINUTE);
  }

  /**
   * M3 §6.4：追蹤「自上次上線以來」的淨值最高／最低點（離線報告用）。
   * 權益定義與 API 一致：可用餘額（現金 + 未結算收入）+ 在場保證金。
   */
  #trackEquity() {
    for (const acct of this.accounts.values()) {
      const eq = acct.equityMilli(this.ticksExecuted);
      let changed = false;
      if (acct.equityHighMilli == null || eq > acct.equityHighMilli) {
        acct.equityHighMilli = eq;
        changed = true;
      }
      if (acct.equityLowMilli == null || eq < acct.equityLowMilli) {
        acct.equityLowMilli = eq;
        changed = true;
      }
      if (changed) this.persistAccountMeta(acct);
    }
  }

  #recordPrice(price, basePrice) {
    if (this._loading) return;
    const minuteId = this.#currentMinuteId();
    if (!this.candle) {
      // 該分鐘已封存（交易剛好發生在分鐘邊界）→ 價格不 retroactively 寫入舊 K 線，
      // 成交量則暫存到下一根 K 線（§4.1：成交量以分鐘 bucket 統計）
      if (minuteId <= this.lastClosedMinuteId) return;
      this.candle = this.#newCandle(minuteId);
    } else if (this.candle.minute_id !== minuteId) {
      this.candle = this.#newCandle(minuteId);
    }
    const e4 = priceToE4(price);
    if (this.candle.open_e4 === null) {
      this.candle.open_e4 = e4;
      this.candle.high_e4 = e4;
      this.candle.low_e4 = e4;
    }
    if (e4 > this.candle.high_e4) this.candle.high_e4 = e4;
    if (e4 < this.candle.low_e4) this.candle.low_e4 = e4;
    this.candle.close_e4 = e4;
    this.candle.base_close_e4 = priceToE4(basePrice);
  }

  #newCandle(minuteId) {
    const candle = {
      minute_id: minuteId,
      open_e4: null,
      high_e4: null,
      low_e4: null,
      close_e4: null,
      base_close_e4: null,
      net_notional_milli: 0,
      volume_notional_milli: 0,
      supply_a_milli: 0,
    };
    if (this.pendingVolumeMilli) {
      candle.volume_notional_milli = this.pendingVolumeMilli;
      this.pendingVolumeMilli = 0;
    }
    return candle;
  }

  #addVolume(notionalMilli) {
    if (this.candle) this.candle.volume_notional_milli += notionalMilli;
    else this.pendingVolumeMilli += notionalMilli;
  }

  #closeMinute() {
    if (!this.candle) return;
    this.candle.net_notional_milli = Math.round(this.market.netNotionalA * MILLI_PER_A);
    this.candle.supply_a_milli = this.totalSupplyMilli();
    this.store.saveCandle(this.candle);
    this.lastClosedMinuteId = this.candle.minute_id;

    // 成交量進滾動視窗 → 分鐘邊界重算 L（§4.1：缺的分鐘以 0 計）
    this.market.pushMinuteVolume(this.candle.volume_notional_milli / MILLI_PER_A);
    this.market.recomputeLiquidity();

    // 定期結算收入（§5.4）
    if (this.ticksExecuted % SETTLE_EVERY_TICKS === 0) {
      for (const acct of this.accounts.values()) {
        acct.settle(this.ticksExecuted);
        this.store.saveAccount?.({
          user_id: acct.userId,
          balance_milli: acct.balanceMilli,
          settled_tick_id: acct.settledTickId,
          last_settled_tick: acct.settledTickId,
          created_at: 0,
        });
      }
    }

    // tick_id 隨 K 線持久化
    this.store.saveEngineState?.(this.serializeState());
    this.candle = null;
  }

  #persistEvent(ev) {
    ev.id = this.nextEventId++;
    this.store.saveEvent?.({
      id: ev.id,
      ts: ev.ts ?? this.ticksExecuted - 1,
      headline: ev.headline,
      pct: ev.pct,
      type: ev.type,
      permanentShare: ev.permanentShare,
      halfLifeSec: ev.halfLifeSec,
    });
    // M2：通知上層（payload 已濾掉 type / permanent_share，見 spec §7.7）
    if (this.onEvent) {
      this.onEvent({
        id: ev.id,
        tick_id: ev.ts ?? this.ticksExecuted - 1,
        headline: ev.headline ?? '',
        impact_jump: ev.pct ?? 0,
      });
    }
  }

  /** M2：強平通知（給 WS 推給受影響的使用者） */
  #notifyLiquidated(r) {
    if (!this.onLiquidation) return;
    this.onLiquidation({
      user_id: r.position.userId,
      position_id: r.position.id,
      price_e4: r.exitPriceE4,
      pnl_milli: r.pnlMilli,
    });
  }

  /** M2：停損停利平倉通知 */
  #notifyPositionClosed(r, kind) {
    if (!this.onPositionClosed) return;
    this.onPositionClosed({
      user_id: r.position.userId,
      position_id: r.position.id,
      price_e4: r.exitPriceE4,
      pnl_milli: r.pnlMilli,
      kind,
    });
  }
}

export { LEVERAGE_OPTIONS };
export default Engine;
