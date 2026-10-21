/**
 * FXSimulator M1 — 全部常數集中在此檔。
 * 數值來源：FXSimulator-Spec.md §2、§4、§5、§6.2、§7.5、§10。
 *
 * 單位約定
 *   - 金額：milli-A（1 A = 1,000），整數
 *   - 價格：e4（1 A = 10,000 單位），整數儲存；模擬過程用 float
 *   - 時間：tick（1 tick = 1 秒「市場時間」；經濟時間另計）
 */

// ---------------------------------------------------------------- 基本單位
export const MILLI_PER_A = 1000;
export const E4 = 10000; // 價格刻度：5.0000 → 50000

// ---------------------------------------------------------------- 標的 / 價格
export const SYMBOL = 'A/B';
export const BASE_PRICE = 5.0; // 起始 1 B = 5.0000 A
export const BASE_PRICE_E4 = 50000;
export const MU_INITIAL = Math.log(BASE_PRICE);

// ---------------------------------------------------------------- 帳戶 / 收入
export const INITIAL_BALANCE_MILLI = 100_000_000; // 起始 100,000 A
export const INCOME_MILLI_PER_TICK = 35_000; // 35 A / tick（= 35 A / 秒）
export const DEFAULT_USER_ID = 1;
export const DEFAULT_SEED = 42;

// ---------------------------------------------------------------- 時間刻度
export const TICKS_PER_MINUTE = 60;
export const TICKS_PER_HOUR = 3600;
export const HOURS_PER_YEAR = 8760; // 持倉費分母（年小時數）
export const SECONDS_PER_DAY = 86400;

// ---------------------------------------------------------------- 商品規格（§5.1）
export const MIN_NOTIONAL_A = 10_000;
export const MIN_NOTIONAL_MILLI = MIN_NOTIONAL_A * MILLI_PER_A;
export const MARGIN_STEP_A = 10; // 保證金級距 10 A
export const LEVERAGE_OPTIONS = [1, 2, 5, 10, 20, 50, 100];
export const DEFAULT_LEVERAGE = 10;
export const MAX_POSITIONS = 5; // 同時持倉上限 5 張
export const SPREAD_HALF = 0.0002; // 點差內含，單邊 0.02%
export const MAINTENANCE_MARGIN_RATE = 0.002; // 維持保證金 = 名目 × 0.2%（D35）

// ---------------------------------------------------------------- 持倉費（§5.5）
export const FEE_LONG_ANNUAL = 0.026; // 做多 2.6% / 年
export const FEE_SHORT_ANNUAL = 0.009; // 做空 0.9% / 年

// ---------------------------------------------------------------- 停損停利（§5.1 / §7.5）
export const MIN_SL_DISTANCE = 0.0005; // 最小停損距離 0.05%
export const SL_MAX_LIQ_FACTOR = 0.9; // 停損上限 = 強平距離 × 0.9

// ---------------------------------------------------------------- 價格影響（§4.1）
export const IMPACT_K = 1.0; // 價格影響係數
export const IMPACT_SATURATION = 0.2; // 飽和係數 → 單邊最大 ±20%
export const LIQUIDITY_L_MIN = 3_000_000; // L 下限（A）
export const LIQUIDITY_VOLUME_FACTOR = 0.001; // L = 0.001 × 24h 名目成交量
export const LIQUIDITY_WINDOW_MINUTES = 1440; // 24h = 1,440 個 1 分鐘 bucket
export const MAX_ORDER_NOTIONAL_MULTIPLE = 2; // 單筆上限 2 × L
export const MAX_USER_NOTIONAL_MULTIPLE = 4; // 單人總名目上限 4 × L

// ---------------------------------------------------------------- OU 日常波動（§4.2）
export const OU_THETA = 8e-6; // 均值回歸速度（/秒）
export const OU_SIGMA = 1.4e-4; // 波動率（/√秒）
export const DT = 1; // tick = 1 秒市場時間

// ---------------------------------------------------------------- 事件（§4.2）
// meanIntervalSec：指數間隔（結構性平均間隔）的均值（秒）
export const EVENT_TYPES = ['structural', 'major', 'news'];

export const EVENTS = {
  structural: {
    type: 'structural',
    meanIntervalSec: 10.5 * SECONDS_PER_DAY, // 10.5 天
    ampRange: [0.02, 0.05], // ±2～5%
    permanentShare: 1, // 結構事件 100% 永久
    halfLifeSecRange: null, // 無衰減
    pathNoise: 0, // 無路徑噪音
  },
  major: {
    type: 'major',
    meanIntervalSec: 1.5 * 3600, // 1.5 小時
    ampRange: [0.015, 0.04], // ±1.5～4%
    stickyProbRange: [0.015, 0.03], // 黏著型機率 1.5～3%
    permanentShareRange: [0.3, 0.7], // 黏著型的永久比例 30～70%
    halfLifeSecRange: [2 * 3600, 6 * 3600], // 半衰期 2～6 小時
    pathNoise: 0.5, // 路徑噪音 = 0.5 × 瞬時影響
  },
  news: {
    type: 'news',
    meanIntervalSec: 7.5 * 60, // 7.5 分鐘
    ampRange: [0.003, 0.01], // ±0.3～1%
    permanentShare: 0,
    halfLifeSecRange: [15 * 60, 30 * 60], // 半衰期 15～30 分鐘
    pathNoise: 0.25, // 路徑噪音 = 0.25 × 瞬時影響
  },
};

// 新聞看板文案池（§7.7：依類型加權抽取，玩家不可由關鍵字直接分類）
export const HEADLINES = {
  structural: [
    '央行重新檢討政策框架',
    '財政路徑長期重估',
    '跨境資本流動規則調整',
    '基準利率體系重新定錨',
  ],
  major: [
    '政策轉向聲明意外發布',
    '大型合約出現異常成交',
    '流動性提供者集體撤單',
    '監管機構臨時公告',
  ],
  news: [
    '出口數據優於預期',
    '製造業訂單小幅回落',
    '零售數據平淡',
    '能源庫存低於預期',
    '就業報告小幅上修',
    '鄰近市場傳出雜訊',
  ],
};

export const CONFIG = Object.freeze({
  MILLI_PER_A,
  E4,
  SYMBOL,
  BASE_PRICE,
  BASE_PRICE_E4,
  MU_INITIAL,
  INITIAL_BALANCE_MILLI,
  INCOME_MILLI_PER_TICK,
  DEFAULT_USER_ID,
  DEFAULT_SEED,
  TICKS_PER_MINUTE,
  TICKS_PER_HOUR,
  HOURS_PER_YEAR,
  MIN_NOTIONAL_A,
  MIN_NOTIONAL_MILLI,
  MARGIN_STEP_A,
  LEVERAGE_OPTIONS,
  DEFAULT_LEVERAGE,
  MAX_POSITIONS,
  SPREAD_HALF,
  MAINTENANCE_MARGIN_RATE,
  FEE_LONG_ANNUAL,
  FEE_SHORT_ANNUAL,
  MIN_SL_DISTANCE,
  SL_MAX_LIQ_FACTOR,
  IMPACT_K,
  IMPACT_SATURATION,
  LIQUIDITY_L_MIN,
  LIQUIDITY_VOLUME_FACTOR,
  LIQUIDITY_WINDOW_MINUTES,
  MAX_ORDER_NOTIONAL_MULTIPLE,
  MAX_USER_NOTIONAL_MULTIPLE,
  OU_THETA,
  OU_SIGMA,
  DT,
  EVENTS,
  HEADLINES,
});

export default CONFIG;
