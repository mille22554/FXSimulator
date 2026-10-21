/**
 * M2 即時迴圈（live hub）。
 *
 * 職責：
 *   1. 每秒推進引擎（`engine.tick(1)`），用 `setTimeout` + `performance.now()` 做
 *      **漂移校正**（drift correction）：到期時間走「固定網格」，累積誤差不會愈滾愈大；
 *      若行程被暫停過久，最多補跑 `catchUpMax` 個 tick，避免爆發式前進。
 *   2. 每秒把 `tick` 廣播給所有連線中的使用者（同一使用者的 payload 只序列化一次）。
 *   3. 引擎產生新事件時廣播 `event`。
 *   4. 發生強平時只通知受影響的使用者（`liquidation`）。
 *
 * 設計重點（spec §3.2）：「序列化一次、同一 buffer 送給所有人」——本檔對同一個
 * userId 只做一次 `JSON.stringify`，再把同一段字串送給該使用者的所有連線。
 *
 * 測試可用法：`new LiveHub({ engine })` 之後 **不要** 呼叫 `start()`，即可完全停用
 * tick 迴圈（`live: false`），改由測試手動呼叫 `engine.tick()` 與 `hub.broadcastTick()`。
 */

import { eventJson, tickJson } from './serialize.js';

const WS_OPEN = 1; // ws.WebSocket.OPEN

export class LiveHub {
  /**
   * @param {object} opts
   * @param {object} opts.engine   Engine 實例
   * @param {number} opts.tickMs   tick 間隔（毫秒，預設 1000）
   * @param {number} opts.catchUpMax 行程卡住後最多補跑幾個 tick（預設 3）
   */
  constructor({ engine, tickMs = 1000, catchUpMax = 3 } = {}) {
    if (!engine) throw new Error('LiveHub 需要 engine');
    this.engine = engine;
    this.tickMs = tickMs;
    this.catchUpMax = catchUpMax;
    this.clients = new Set();
    this.timer = null;
    this.running = false;
    this.nextDueAt = 0;
    this.ticks = 0;
    this.now = () => performance.now();

    // 引擎 → 對外通知（只掛鉤子，不改動任何經濟邏輯）
    engine.onEvent = (ev) => this.broadcastEvent(ev);
    engine.onLiquidation = (info) =>
      this.sendLiquidation(info.user_id, {
        position_id: info.position_id,
        price_e4: info.price_e4,
        pnl_milli: info.pnl_milli,
      });
  }

  // ------------------------------------------------------------ 連線管理
  /** @param {{userId:number, sendText:(text:string)=>void}} client */
  addClient(client) {
    this.clients.add(client);
    return client;
  }

  removeClient(client) {
    this.clients.delete(client);
  }

  get clientCount() {
    return this.clients.size;
  }

  /** 連線中的使用者（去重） */
  userIds() {
    return [...new Set([...this.clients].map((c) => c.userId))];
  }

  // ------------------------------------------------------------ 迴圈
  start() {
    if (this.running) return this;
    this.running = true;
    this.nextDueAt = this.now() + this.tickMs;
    this.#schedule();
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this;
  }

  #schedule() {
    if (!this.running) return;
    const delay = Math.max(0, this.nextDueAt - this.now());
    this.timer = setTimeout(() => this.#onTimer(), delay);
    // 不讓 tick 計時器單獨keep住 process（測試 / 關機時更乾淨）
    this.timer.unref?.();
  }

  #onTimer() {
    this.timer = null;
    if (!this.running) return;

    const nowMs = this.now();
    // 落後幾個週期（0 = 準時）
    let behind = Math.floor((nowMs - this.nextDueAt) / this.tickMs);
    if (behind < 0) behind = 0;
    const catchUp = Math.min(behind, this.catchUpMax);

    // 下一個到期時間：沿固定網格前進 → 不累積漂移
    this.nextDueAt += (behind + 1) * this.tickMs;

    for (let i = 0; i <= catchUp; i++) {
      this.engine.tick(1);
      this.ticks += 1;
    }

    this.broadcastTick();
    this.#schedule();
  }

  // ------------------------------------------------------------ 廣播
  /** 每秒的 `tick`（同一使用者只序列化一次） */
  broadcastTick() {
    if (this.clients.size === 0) return;
    const byUser = new Map();
    for (const client of this.clients) {
      if (!byUser.has(client.userId)) byUser.set(client.userId, []);
      byUser.get(client.userId).push(client);
    }
    for (const [userId, clients] of byUser) {
      const text = JSON.stringify({
        type: 'tick',
        data: tickJson({ engine: this.engine, userId }),
      });
      for (const client of clients) this.#send(client, text);
    }
  }

  /** 新事件 → 廣播給所有人 */
  broadcastEvent(ev) {
    if (this.clients.size === 0) return;
    const text = JSON.stringify({ type: 'event', data: eventJson(ev) });
    for (const client of this.clients) this.#send(client, text);
  }

  /** 強平 → 只送給受影響的使用者 */
  sendLiquidation(userId, data) {
    if (this.clients.size === 0) return;
    const text = JSON.stringify({ type: 'liquidation', data });
    for (const client of this.clients) {
      if (client.userId === userId) this.#send(client, text);
    }
  }

  /** 單一連線送訊息（給 API 層用：snapshot / order.filled / order.rejected / pong） */
  sendTo(client, message) {
    this.#send(client, JSON.stringify(message));
  }

  #send(client, text) {
    try {
      client.sendText(text);
    } catch {
      /* 連線已斷：忽略（由 close 事件清理） */
    }
  }
}

export { WS_OPEN };
export default LiveHub;
