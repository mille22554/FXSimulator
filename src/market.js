/**
 * 市場引擎（spec §4）。
 *
 * 價格三層：
 *   q = μ + x + Σ T_i
 *   P_base = exp(q)
 *   P      = P_base × (1 + 0.2 × tanh(k × N / L))     ← 玩家淨部位衝擊
 *
 *   μ：長期錨（結構事件永久移動）
 *   x：OU 日常波動   dx = −θx·dt + σ√dt·N(0,1)
 *   T_i：事件暫態    dT_i = −λ_i T_i·dt + σ_i√dt·N(0,1)
 *
 * 事件間隔採指數分布（不可預測、不預告）。
 */

import {
  BASE_PRICE,
  DT,
  EVENTS,
  EVENT_TYPES,
  HEADLINES,
  IMPACT_K,
  IMPACT_SATURATION,
  LIQUIDITY_L_MIN,
  LIQUIDITY_VOLUME_FACTOR,
  LIQUIDITY_WINDOW_MINUTES,
  MU_INITIAL,
  OU_SIGMA,
  OU_THETA,
} from './config.js';

const LN2 = Math.log(2);

/** 依類型抽一則文案 */
export function pickHeadline(rng, type) {
  const pool = HEADLINES[type] ?? HEADLINES.news;
  return pool[rng.int(pool.length)];
}

/**
 * 抽一個事件（不含落地：回傳跳空、永久比例、衰減參數）。
 * 這是「抽樣器」，測試可直接呼叫 10,000 次檢驗分佈。
 */
export function sampleEvent(rng, type) {
  const cfg = EVENTS[type];
  const amp = rng.uniform(cfg.ampRange[0], cfg.ampRange[1]);
  const pct = amp * rng.sign(); // 百分比幅度（可正可負）
  const jump = Math.log(1 + pct); // 對數空間跳空

  const ev = {
    type,
    pct, // 已實現跳空（百分比，顯示用）
    jump, // 對數空間跳空
    permanentShare: 0,
    isSticky: false,
    halfLifeSec: null,
    lambda: 0,
    sigma: 0,
    headline: pickHeadline(rng, type),
  };

  if (type === 'structural') {
    ev.permanentShare = 1; // 結構事件 100% 永久
  } else if (type === 'major') {
    const stickyProb = rng.uniform(cfg.stickyProbRange[0], cfg.stickyProbRange[1]);
    if (rng.next() < stickyProb) {
      ev.isSticky = true;
      ev.permanentShare = rng.uniform(cfg.permanentShareRange[0], cfg.permanentShareRange[1]);
    }
    ev.halfLifeSec = rng.uniform(cfg.halfLifeSecRange[0], cfg.halfLifeSecRange[1]);
    ev.lambda = LN2 / ev.halfLifeSec;
  } else {
    ev.halfLifeSec = rng.uniform(cfg.halfLifeSecRange[0], cfg.halfLifeSecRange[1]);
    ev.lambda = LN2 / ev.halfLifeSec;
  }

  // 暫態分量的初始值 = jump × (1 − 永久比例)
  const t0 = jump * (1 - ev.permanentShare);
  // σ_i = |T_i(0)| × path_noise × √(2λ_i) → 穩態路徑標準差 ≈ 瞬時影響 × path_noise
  ev.sigma = Math.abs(t0) * cfg.pathNoise * Math.sqrt(2 * ev.lambda);
  ev.t0 = t0;
  return ev;
}

export class Market {
  constructor({ seed = 42, rng = null } = {}) {
    this.rng = rng;
    this.mu = MU_INITIAL; // 長期錨（log 空間）
    this.x = 0; // OU 分量
    this.components = []; // 事件暫態 T_i
    this.netNotionalA = 0; // 全服淨多頭名目（A）
    this.L = LIQUIDITY_L_MIN; // 流動性深度（A）
    this.volumeWindow = []; // 最近 1,440 個分鐘的名目成交量（A）
    this.countdowns = {}; // 各類事件的倒數（秒）
    this.basePrice = BASE_PRICE;
    this.price = BASE_PRICE;
    this.onPriceChange = null; // (price, basePrice) => void
    this.onEvent = null; // (event) => void
    this.events = []; // 事件紀錄（最近若干筆）
    for (const type of EVENT_TYPES) {
      this.countdowns[type] = this.rng.exponential(EVENTS[type].meanIntervalSec);
    }
    this.recomputePrice();
  }

  // ------------------------------------------------------------ 價格
  /** 玩家衝擊倍率：1 + 0.2 × tanh(k·N/L) */
  impactMultiplier(netNotionalA = this.netNotionalA) {
    return 1 + IMPACT_SATURATION * Math.tanh((IMPACT_K * netNotionalA) / this.L);
  }

  /** Σ T_i */
  get transientSum() {
    let s = 0;
    for (const c of this.components) s += c.T;
    return s;
  }

  recomputePrice() {
    this.basePrice = Math.exp(this.mu + this.x + this.transientSum);
    this.price = this.basePrice * this.impactMultiplier();
    if (this.onPriceChange) this.onPriceChange(this.price, this.basePrice);
    return this.price;
  }

  /** 設定全服淨多頭名目（A），並重算價格 */
  setNetNotional(notionalA) {
    this.netNotionalA = notionalA;
    return this.recomputePrice();
  }

  /** 增减淨部位（A）：開多 +、平多 −、開空 −、平空 + */
  addNotional(deltaA) {
    this.netNotionalA += deltaA;
    return this.recomputePrice();
  }

  /**
   * 人工注入價格跳空（測試 / 情境用）。
   * @param {number} ret 例如 -0.04 代表 −4%
   */
  applyShock(ret) {
    this.mu += Math.log(1 + ret);
    return this.recomputePrice();
  }

  // ------------------------------------------------------------ 時間推進
  /**
   * 推進 dt 秒市場時間。
   * @param {number} dt  秒（預設 1 = 1 tick）
   * @param {number} tickId 目前 tick 序號（寫進事件紀錄）
   */
  step(dt = DT, tickId = null) {
    // 1) OU 日常波動
    this.x += -OU_THETA * this.x * dt + OU_SIGMA * Math.sqrt(dt) * this.rng.normal();

    // 2) 既有事件暫態衰減（先衰減，再落地新事件，避免新事件立刻被衰減）
    for (const c of this.components) {
      c.T += -c.lambda * c.T * dt + c.sigma * Math.sqrt(dt) * this.rng.normal();
    }
    this.components = this.components.filter((c) => Math.abs(c.T) > 1e-12);

    // 3) 事件排程（指數間隔）
    for (const type of EVENT_TYPES) {
      this.countdowns[type] -= dt;
      if (this.countdowns[type] <= 0) {
        this.countdowns[type] += this.rng.exponential(EVENTS[type].meanIntervalSec);
        this.fireEvent(type, tickId);
      }
    }

    this.recomputePrice();
    return this.price;
  }

  /** 事件落地：結構 → μ；重大/新聞 → 永久部分進 μ、暫態進 T_i */
  fireEvent(type, tickId = null) {
    const ev = sampleEvent(this.rng, type);
    ev.ts = tickId;
    ev.id = this.events.length + 1;
    this.mu += ev.jump * ev.permanentShare;
    if (ev.t0 !== 0) {
      this.components.push({ T: ev.t0, lambda: ev.lambda, sigma: ev.sigma, type });
    }
    this.events.push(ev);
    if (this.events.length > 1000) this.events.shift();
    if (this.onEvent) this.onEvent(ev);
    return ev;
  }

  // ------------------------------------------------------------ 流動性
  /** 分鐘結束時把該分鐘成交量推進滾動視窗 */
  pushMinuteVolume(volumeA) {
    this.volumeWindow.push(volumeA);
    while (this.volumeWindow.length > LIQUIDITY_WINDOW_MINUTES) this.volumeWindow.shift();
  }

  /** 分鐘邊界重算 L（缺的分鐘以 0 計） */
  recomputeLiquidity() {
    let total = 0;
    for (const v of this.volumeWindow) total += v;
    this.L = Math.max(LIQUIDITY_L_MIN, LIQUIDITY_VOLUME_FACTOR * total);
    return this.L;
  }

  /** 序列化 / 還原 */
  toJSON() {
    return {
      mu: this.mu,
      x: this.x,
      components: this.components.map((c) => ({ ...c })),
      netNotionalA: this.netNotionalA,
      L: this.L,
      volumeWindow: [...this.volumeWindow],
      countdowns: { ...this.countdowns },
    };
  }

  fromJSON(obj) {
    if (!obj) return;
    this.mu = obj.mu;
    this.x = obj.x;
    this.components = (obj.components ?? []).map((c) => ({ ...c }));
    this.netNotionalA = obj.netNotionalA;
    this.L = obj.L;
    this.volumeWindow = [...(obj.volumeWindow ?? [])];
    this.countdowns = { ...this.countdowns, ...(obj.countdowns ?? {}) };
    this.recomputePrice();
  }
}

export default Market;
