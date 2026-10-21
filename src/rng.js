/**
 * 決定性亂數來源：mulberry32 + 均勻 / 常態（Box-Muller）/ 指數分布。
 * 全專案的隨機性都必須經過這裡，確保同種子可完全重播。
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 42) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  /** 均勻分布 [0, 1) */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 均勻分布 [min, max) */
  uniform(min = 0, max = 1) {
    return min + (max - min) * this.next();
  }

  /** 整數 [0, n) */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /** 標準常態 N(0,1)（Box-Muller，不快取第二個值以保持狀態單純） */
  normal() {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** 指數分布（均值 = mean），用於事件間隔 */
  exponential(mean = 1) {
    return -Math.log(Math.max(this.next(), 1e-12)) * mean;
  }

  /** ±1 號 */
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }

  getState() {
    return this.state >>> 0;
  }

  setState(state) {
    this.state = state >>> 0;
  }
}

export default Rng;
