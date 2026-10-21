/**
 * 帳戶 / 持倉邏輯（spec §5）。
 *
 * 會計約定（M1 選擇，已於 README「實作選擇」列出）：
 *   - balance_milli = 現金餘額（可用餘額）。開倉時先把「保證金」從現金扣掉。
 *   - 平倉時：現金 += 保證金 + 損益 → 等價於「餘額變化 = 實際損益」。
 *   - 虧損超過保證金時現金可為負（欠款），欠款期間不得開新倉。
 *   - 收入以 tick 計：balance += 35,000 × (tick_count − settled_tick_id)。
 *   - 一切時間判斷用 tick_id，不使用 wall clock。
 */

import {
  FEE_LONG_RATE_NUM,
  FEE_SHORT_RATE_NUM,
  LEVERAGE_OPTIONS,
  MARGIN_STEP_A,
  MAINTENANCE_MARGIN_RATE,
  MAX_POSITIONS,
  MAX_ORDER_NOTIONAL_MULTIPLE,
  MAX_USER_NOTIONAL_MULTIPLE,
  MILLI_PER_A,
  MIN_NOTIONAL_A,
  MIN_NOTIONAL_MILLI,
  MIN_SL_DISTANCE,
  SL_MAX_LIQ_FACTOR,
  SPREAD_HALF,
  INCOME_MILLI_PER_TICK,
} from './config.js';
import { aToMilli, chargeFromMicro, hourlyFeeMicro, priceToE4, roundHalfUp } from './money.js';

/** §7.5：minMargin(lev) = ceil(10,000 / lev / 10) × 10 */
export function minMarginForLeverage(leverage) {
  return Math.ceil(MIN_NOTIONAL_A / leverage / MARGIN_STEP_A) * MARGIN_STEP_A;
}

/** 強平距離 = 1/槓桿 − 0.2%（§5.2） */
export function liquidationDistance(leverage) {
  return 1 / leverage - MAINTENANCE_MARGIN_RATE;
}

function floorToMultiple(value, step) {
  return Math.floor(value / step) * step;
}

export class Position {
  constructor({
    id,
    userId,
    side,
    notionalMilli,
    leverage,
    marginMilli,
    entryPriceE4,
    liqPriceE4,
    slPriceE4 = null,
    tpPriceE4 = null,
    feeRemainderMicro = 0,
    status = 'open',
    openedAt = 0,
    closedAt = null,
    closePriceE4 = null,
    pnlMilli = 0,
  }) {
    this.id = id;
    this.userId = userId;
    this.side = side; // 'long' | 'short'
    this.notionalMilli = notionalMilli;
    this.leverage = leverage;
    this.marginMilli = marginMilli;
    this.entryPriceE4 = entryPriceE4;
    this.liqPriceE4 = liqPriceE4;
    this.slPriceE4 = slPriceE4;
    this.tpPriceE4 = tpPriceE4;
    this.feeRemainderMicro = feeRemainderMicro; // §5.5：費用找零（微 A，整數）
    this.status = status; // 'open' | 'closed' | 'liquidated'
    this.openedAt = openedAt;
    this.closedAt = closedAt;
    this.closePriceE4 = closePriceE4;
    this.pnlMilli = pnlMilli;
  }

  get isLong() {
    return this.side === 'long';
  }

  /** 浮動損益（milli-A），以 e4 價格計算，可重複結算不累積誤差 */
  floatingPnlMilli(markE4) {
    const diff = this.isLong ? markE4 - this.entryPriceE4 : this.entryPriceE4 - markE4;
    return roundHalfUp((diff * this.notionalMilli) / this.entryPriceE4);
  }

  /**
   * API 用的 `pnl_milli`：未平倉部位 = 以當前標記價計算的浮動損益；
   * 已平倉部位 = 已實現損益。整數 milli-A。
   * @param {number|null} markE4 當前標記價（e4 整數）
   */
  pnlMilliAt(markE4) {
    if (this.status === 'open' && markE4 != null) return this.floatingPnlMilli(markE4);
    return this.pnlMilli ?? 0;
  }

  /** 未實現虧損（正數） */
  unrealizedLossMilli(markE4) {
    return Math.max(0, -this.floatingPnlMilli(markE4));
  }

  /** 強平門檻：保證金 − 維持保證金（名目 × 0.2%） */
  liquidationThresholdMilli() {
    const maintenance = Math.round(this.notionalMilli * MAINTENANCE_MARGIN_RATE);
    return this.marginMilli - maintenance;
  }
}

export class Account {
  constructor({ userId, balanceMilli = 0, settledTickId = 0, displayName = null }) {
    this.userId = userId;
    this.balanceMilli = balanceMilli;
    this.settledTickId = settledTickId;
    this.displayName = displayName;
    this.positions = new Map();
    this.onTrade = null; // (trade) => void
    this.onLedger = null; // (entry) => void
    this.onPositionUpdate = null; // (position) => void
  }

  // ------------------------------------------------------------ 收入
  /** 可用餘額（已含未結算收入） */
  availableMilli(tickCount) {
    return this.balanceMilli + INCOME_MILLI_PER_TICK * Math.max(0, tickCount - this.settledTickId);
  }

  /** 結算收入（把 accrued 寫回 balance_milli） */
  settle(tickCount) {
    const pending = Math.max(0, tickCount - this.settledTickId);
    const gained = INCOME_MILLI_PER_TICK * pending;
    this.balanceMilli += gained;
    this.settledTickId = Math.max(this.settledTickId, tickCount);
    return gained;
  }

  openPositions() {
    return [...this.positions.values()].filter((p) => p.status === 'open');
  }

  get totalMarginMilli() {
    return this.openPositions().reduce((s, p) => s + p.marginMilli, 0);
  }

  /** 權益 = 現金 + 在場保證金（用於總供給計算） */
  equityMilli(tickCount) {
    return this.availableMilli(tickCount) + this.totalMarginMilli;
  }

  // ------------------------------------------------------------ 開倉
  /**
   * 市價開倉。
   * @param {object} opts
   *   side 'long'|'short'、marginA 保證金(A)、leverage 槓桿、
   *   slPct/tpPct 停損停利（0.005 = 0.5%）、market、tickCount、positionId
   */
  openPosition({ side, marginA, leverage, slPct = null, tpPct = null, market, tickCount, positionId }) {
    this.settle(tickCount);

    if (side !== 'long' && side !== 'short') return { ok: false, reason: 'side_invalid' };
    if (!LEVERAGE_OPTIONS.includes(leverage)) return { ok: false, reason: 'leverage_invalid' };
    if (this.balanceMilli < 0) return { ok: false, reason: 'debt_no_open' };
    if (this.openPositions().length >= MAX_POSITIONS) {
      return { ok: false, reason: 'max_positions', limit: MAX_POSITIONS };
    }
    if (!Number.isFinite(marginA) || marginA <= 0) return { ok: false, reason: 'margin_invalid' };
    if (marginA % MARGIN_STEP_A !== 0) {
      return { ok: false, reason: 'margin_step', step: MARGIN_STEP_A };
    }
    const minMarginA = minMarginForLeverage(leverage);
    if (marginA < minMarginA) {
      return { ok: false, reason: 'min_margin', minMarginA };
    }

    const available = this.balanceMilli;
    const marginMilli = aToMilli(marginA);
    if (marginMilli > available) return { ok: false, reason: 'insufficient_balance' };

    // 名目上限：min(2L, 可用餘額 × 槓桿)；另受單人總名目 4L 限制
    const maxByLiquidity = Math.floor(MAX_ORDER_NOTIONAL_MULTIPLE * market.L * MILLI_PER_A);
    const maxByBalance = available * leverage;
    const userTotal = this.openPositions().reduce((s, p) => s + p.notionalMilli, 0);
    const roomForUser = Math.max(
      0,
      Math.floor(MAX_USER_NOTIONAL_MULTIPLE * market.L * MILLI_PER_A) - userTotal,
    );
    const capMilli = Math.min(maxByLiquidity, maxByBalance, roomForUser);

    // 名目必須是「保證金級距 × 槓桿」的整數倍，保證金才是整數 A
    const notionalStepMilli = MARGIN_STEP_A * leverage * MILLI_PER_A;
    let notionalMilli = marginMilli * leverage;
    let truncated = false;
    if (notionalMilli > capMilli) {
      notionalMilli = floorToMultiple(capMilli, notionalStepMilli);
      truncated = true;
    }
    if (notionalMilli < MIN_NOTIONAL_MILLI) {
      return { ok: false, reason: 'min_notional', minNotionalA: MIN_NOTIONAL_A };
    }
    const finalMarginMilli = notionalMilli / leverage;

    // 停損停利驗證（§5.1 / §7.5）——必須在改動市場前完成，否則失敗會留下殘留衝擊
    const liqDist = liquidationDistance(leverage);
    if (slPct != null) {
      if (!(slPct >= MIN_SL_DISTANCE)) {
        return { ok: false, reason: 'sl_too_close', min: MIN_SL_DISTANCE };
      }
      if (slPct > liqDist * SL_MAX_LIQ_FACTOR) {
        return { ok: false, reason: 'sl_beyond_liq', max: liqDist * SL_MAX_LIQ_FACTOR };
      }
    }
    if (tpPct != null && !(tpPct > 0)) {
      return { ok: false, reason: 'tp_invalid' };
    }

    // §4.3：衝擊先發生，成交價取「本次交易完成後」的價格
    const notionalA = notionalMilli / MILLI_PER_A;
    market.addNotional(side === 'long' ? notionalA : -notionalA);
    const mid = market.price;
    const fill = side === 'long' ? mid * (1 + SPREAD_HALF) : mid * (1 - SPREAD_HALF);
    const entryPriceE4 = priceToE4(fill);

    let slPriceE4 = null;
    let tpPriceE4 = null;
    if (slPct != null) {
      slPriceE4 = priceToE4(side === 'long' ? fill * (1 - slPct) : fill * (1 + slPct));
    }
    if (tpPct != null) {
      tpPriceE4 = priceToE4(side === 'long' ? fill * (1 + tpPct) : fill * (1 - tpPct));
    }

    // 扣保證金
    this.balanceMilli -= finalMarginMilli;

    const liqPriceE4 = priceToE4(
      side === 'long' ? fill * (1 - liqDist) : fill * (1 + liqDist),
    );

    const position = new Position({
      id: positionId,
      userId: this.userId,
      side,
      notionalMilli,
      leverage,
      marginMilli: finalMarginMilli,
      entryPriceE4,
      liqPriceE4,
      slPriceE4,
      tpPriceE4,
      openedAt: tickCount,
    });
    this.positions.set(position.id, position);

    this.#trade({
      positionId: position.id,
      kind: 'open',
      priceE4: entryPriceE4,
      notionalMilli,
      feeMilli: 0,
      ts: tickCount,
    });
    this.#ledger(-finalMarginMilli, 'margin_hold', tickCount);
    this.#notifyPosition(position);

    return {
      ok: true,
      position,
      entryPriceE4,
      midPrice: mid,
      notionalMilli,
      marginMilli: finalMarginMilli,
      truncated,
      availableMilli: this.balanceMilli,
    };
  }

  // ------------------------------------------------------------ 平倉
  /**
   * 平掉一張單（手動 / 停損停利 / 強平都走這裡）。
   * @param {object} opts positionId、market、tickCount、reason、status
   */
  closePosition({ positionId, market, tickCount, reason = 'manual', status = 'closed' }) {
    this.settle(tickCount);
    const position = this.positions.get(positionId);
    if (!position) return { ok: false, reason: 'position_not_found' };
    if (position.status !== 'open') return { ok: false, reason: 'position_not_closed' };

    // §4.3：先移除部位造成的衝擊，再以「平倉後價格」成交
    const notionalA = position.notionalMilli / MILLI_PER_A;
    market.addNotional(position.isLong ? -notionalA : notionalA);
    const mid = market.price;
    const exit = position.isLong ? mid * (1 - SPREAD_HALF) : mid * (1 + SPREAD_HALF);
    const exitPriceE4 = priceToE4(exit);

    const diff = position.isLong
      ? exitPriceE4 - position.entryPriceE4
      : position.entryPriceE4 - exitPriceE4;
    const pnlMilli = roundHalfUp((diff * position.notionalMilli) / position.entryPriceE4);

    // 保證金退還 + 損益（可能為負 → 欠款）
    this.balanceMilli += position.marginMilli + pnlMilli;

    position.status = status;
    position.closedAt = tickCount;
    position.closePriceE4 = exitPriceE4;
    position.pnlMilli = pnlMilli;

    this.#trade({
      positionId: position.id,
      kind: status === 'liquidated' ? 'liquidate' : 'close',
      priceE4: exitPriceE4,
      notionalMilli: position.notionalMilli,
      feeMilli: 0,
      ts: tickCount,
    });
    this.#ledger(position.marginMilli, 'margin_refund', tickCount);
    this.#ledger(pnlMilli, 'pnl', tickCount);
    this.#notifyPosition(position);

    return { ok: true, position, pnlMilli, exitPriceE4, midPrice: mid };
  }

  // ------------------------------------------------------------ 強平
  /**
   * 強平檢查（§4.3 / §5.2）：
   *   先「收集全部觸發」，再「依序平倉並重算價格」——不可邊平邊判定。
   */
  liquidateIfNeeded({ market, tickCount }) {
    const markE4 = priceToE4(market.price);
    const triggers = [];
    for (const position of this.openPositions()) {
      const loss = position.unrealizedLossMilli(markE4);
      if (loss >= position.liquidationThresholdMilli()) triggers.push(position);
    }
    const results = [];
    for (const position of triggers) {
      const r = this.closePosition({
        positionId: position.id,
        market,
        tickCount,
        reason: 'liquidation',
        status: 'liquidated',
      });
      if (r.ok) results.push(r);
    }
    return results;
  }

  // ------------------------------------------------------------ 停損停利
  checkStopOrders({ market, tickCount }) {
    const mark = market.price;
    const results = [];
    for (const position of this.openPositions()) {
      if (position.slPriceE4 != null) {
        const sl = position.slPriceE4 / 10000;
        const hit = position.isLong ? mark <= sl : mark >= sl;
        if (hit) {
          const r = this.closePosition({
            positionId: position.id,
            market,
            tickCount,
            reason: 'stop_loss',
            status: 'closed',
          });
          if (r.ok) results.push(r);
          continue;
        }
      }
      if (position.tpPriceE4 != null) {
        const tp = position.tpPriceE4 / 10000;
        const hit = position.isLong ? mark >= tp : mark <= tp;
        if (hit) {
          const r = this.closePosition({
            positionId: position.id,
            market,
            tickCount,
            reason: 'take_profit',
            status: 'closed',
          });
          if (r.ok) results.push(r);
        }
      }
    }
    return results;
  }

  // ------------------------------------------------------------ 持倉費
  /**
   * 整點結算（§5.5 v0.25）：費率以微 A 計算、扣款回毫 A、找零以微 A 累積。
   *   fee_micro            = floor(notional_milli × rate_num ÷ 8760)
   *   fee_milli            = floor((fee_micro + fee_remainder_micro) ÷ 1000)
   *   fee_remainder_micro  = (fee_micro + fee_remainder_micro) % 1000
   * @returns {number} 本次總費用（milli-A）
   */
  chargeHourlyFees(tickCount) {
    let total = 0;
    for (const position of this.openPositions()) {
      const rateNum = position.isLong ? FEE_LONG_RATE_NUM : FEE_SHORT_RATE_NUM;
      const feeMicro = hourlyFeeMicro(position.notionalMilli, rateNum);
      const { chargeMilli, remainderMicro } = chargeFromMicro(
        feeMicro,
        position.feeRemainderMicro,
      );
      position.feeRemainderMicro = remainderMicro;
      if (chargeMilli > 0) {
        this.balanceMilli -= chargeMilli;
        total += chargeMilli;
        this.#ledger(-chargeMilli, 'fee', tickCount);
      }
      // 即使本次扣款為 0，找零仍需寫回（否則找零會遺失）
      this.#notifyPosition(position);
    }
    return total;
  }

  // ------------------------------------------------------------ 內部
  #trade({ positionId, kind, priceE4, notionalMilli, feeMilli, ts }) {
    if (this.onTrade) {
      this.onTrade({
        userId: this.userId,
        positionId,
        kind,
        priceE4,
        notionalMilli,
        feeMilli,
        ts,
      });
    }
  }

  #ledger(deltaMilli, reason, ts) {
    if (this.onLedger) this.onLedger({ userId: this.userId, deltaMilli, reason, ts });
  }

  #notifyPosition(position) {
    if (this.onPositionUpdate) this.onPositionUpdate(position);
  }

  toJSON() {
    return {
      userId: this.userId,
      balanceMilli: this.balanceMilli,
      settledTickId: this.settledTickId,
      displayName: this.displayName,
    };
  }
}

export default Account;
