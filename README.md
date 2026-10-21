# FXSimulator — M1（市場引擎 + 帳戶 + CLI）＋ M2（HTTP API + WebSocket）

依 `FXSimulator-Spec.md` **v0.25** 實作：

- **M1 里程碑**：A/B 合成標的（CFD）的市場引擎、逐倉帳戶、強平與持倉費、SQLite 持久化、CLI 情境驗證。
- **M2 里程碑**：Fastify HTTP API、WebSocket 即時協定、每秒 tick 迴圈，以及 **桌機交易頁**（走勢圖、下單面板、持倉、新聞看板；無建置步驟、無 CDN）。

- 純 ESM JavaScript（Node 20+），**無 TypeScript、無建置步驟**
- 唯一原生相依套件：`better-sqlite3`（以動態 `import()` 載入，純邏輯測試可在原生模組缺席時執行）；
  其餘為純 JS：`fastify`、`@fastify/websocket`、`@fastify/static`、`ws`
- 所有隨機性走 `src/rng.js`（mulberry32），**同種子可完全重播**
- **經濟邏輯不使用 wall clock**：`tick_id` 是唯一真相

---

## 快速開始

```bash
npm install          # 需要 node-gyp（Python + C++ 工具鏈）才能建置 better-sqlite3
npm test             # node --test
npm start            # 啟動 HTTP + WebSocket 伺服器（127.0.0.1:2641）
node src/cli.js init
```

Windows 上若 `better-sqlite3` 沒有對應 Node ABI 的預編譯檔，會退回 `node-gyp` 編譯，
需要 **Python 3.6+** 與 **Visual Studio Build Tools**（C++ 桌面工作負載）。
npm 11.16+ 另有安裝腳本白名單機制，套件已於 `package.json` 的 `allowScripts` 放行。

## 目錄

| 檔案 | 內容 |
|------|------|
| `src/config.js` | 全部常數（經濟參數、事件參數、表格規格） |
| `src/rng.js` | mulberry32 seeded RNG：均勻 / 常態（Box-Muller）/ 指數 |
| `src/money.js` | milli-A / 微 A、e4 價格換算、持倉費微 A 計算（`hourlyFeeMicro` / `chargeFromMicro`）、P&L 四捨五入 |
| `src/market.js` | 價格引擎：OU + 事件三層 + 玩家衝擊 + 流動性深度 L |
| `src/account.js` | 帳戶：收入、開平倉、衝擊成交價、強平、停損停利、持倉費 |
| `src/db.js` | §6.2 schema（WAL）、記憶體 store 與 SQLite store、save/load |
| `src/engine.js` | tick 協調：事件+OU、分鐘 K 線、強平檢查、持久化；M2 加 `onEvent` / `onLiquidation` / `onPositionClosed` 通知鉤子 |
| `src/serialize.js` | **M2**：唯一對外輸出的序列化層（狀態 / tick / 持倉 / K 線 / 事件；事件永不輸出 `type`、`permanent_share`） |
| `src/api.js` | **M2**：REST 路由（`/healthz`、`/api/*`）＋ WebSocket `/ws` 協定處理 |
| `src/live.js` | **M2**：live hub（連線登錄簿、每秒 tick 廣播、事件廣播、強平通知、漂移校正 tick 迴圈） |
| `src/server.js` | **M2**：Fastify app（websocket + 靜態檔）、listen、優雅關機 |
| `src/scenarios.js` | §10 驗收情境（roundtrip / pump / liquidation / gap / opposing） |
| `src/cli.js` | CLI：`init` `status` `tick` `open` `close` `candles` `events` `scenario` `reset` |
| `public/` | **M2**：桌機交易頁（`index.html`、`styles.css`、`js/`；含 `?mock=1` 模擬模式） |
| `test/api.test.js` | **M2**：REST + WebSocket 驗收（`fastify.inject` ＋ `ws`） |


## 前端（M2 桌機）

- `npm start` 後開 `http://127.0.0.1:2641/`（nginx 上為 `https://morowin.win/FXSimulator/`）。
- `?mock=1`：不連伺服器，用內建模擬資料預覽 UI（方便截圖與設計檢查）。
- `?user=1`：M2 臨時使用者；M3 換成 Google session。
- 檔案：`public/index.html`、`public/styles.css`、`public/js/{app,chart,order,positions,news,state,ws,mock,util}.js`。
- 無 CDN、無建置步驟；Canvas 2D；`prefers-reduced-motion` 與鍵盤 focus 已處理。

## CLI

```bash
node src/cli.js init                                    # 建立 DB + 預設帳號（100,000 A）
node src/cli.js status                                  #  tick、價格、餘額、持倉
node src/cli.js tick 3600                               #  跑 N 個 tick
node src/cli.js open --side long --margin 1000 --leverage 10 [--sl 0.5] [--tp 1]
node src/cli.js close 1                                 #  平倉（依 position id）
node src/cli.js candles 60                              #  最近的 1 分 K
node src/cli.js events 20                               #  最近事件（看板用）
node src/cli.js scenario roundtrip|pump|liquidation|gap|opposing
node src/cli.js reset                                   #  刪庫重來
```

通用選項：`--db <path>`（或 `FXSIM_DB` 環境變數）、`--seed <n>`、`--user <id>`。
`--sl` / `--tp` 的單位是**百分比數字**（`0.5` = 0.5%）。

---

## M2 伺服器（HTTP + WebSocket）

```bash
npm start    # node src/server.js
```

| 環境變數 | 預設 | 說明 |
|----------|------|------|
| `HOST` | `127.0.0.1` | 監聽位址（對外由 nginx 反代） |
| `PORT` | `2641` | 監聽埠 |
| `FXSIM_DB` | `./fxsim.db` | SQLite 路徑 |
| `FXSIM_SEED` | `42` | RNG 種子 |

nginx 會剝掉 `/FXSimulator/` 前綴（`proxy_pass http://127.0.0.1:2641/`），因此本服務自帶路徑：
`/`（靜態頁）、`/api/*`、`/ws`。

### REST

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/healthz` | `{ ok, tick_id, uptime_s }` |
| GET | `/api/config` | 槓桿選項、最小保證金、上限、費率 |
| GET | `/api/state?user=1` | 完整狀態（market / account / positions / candles / events） |
| GET | `/api/candles?limit=60` | 1 分 K，**最舊 → 最新**，上限 600 |
| GET | `/api/events?limit=100` | 事件，**最新 → 最舊**；**永不**含 `type` / `permanent_share` |
| POST | `/api/open` | `{ side, margin_a, leverage, sl_pct?, tp_pct? }` → `{ ok, position, fill }` |
| POST | `/api/close` | `{ position_id }` → `{ ok, exit_price_e4, pnl_milli }` |

### WebSocket `/ws?user=1`

- 伺服器 → 客戶端：`snapshot`（連線即送）｜`tick`（每秒）｜`order.filled` / `order.rejected`
  （回傳 `request_id`）｜`liquidation`（只送受影響的使用者）｜`event`｜`pong`
- 客戶端 → 伺服器：`order.open`｜`order.close`｜`ping`
- 重連後伺服器會重新送 `snapshot`，前端以 `snapshot` 覆蓋本地狀態。

### 單位與認證（M2 臨時制）

- 金額一律**整數 milli-A**（`_milli`）、價格一律**整數 e4**（`_e4`）、百分比為小數比例。
- `sl_pct` / `tp_pct` 依 contract 請求範例以**百分比數字**解讀（`0.5` = 0.5%）；
  若百分比解讀違反引擎限制而小數比例解讀合法，則自動改採小數比例（相容兩種前端寫法）。
- 暫時無登入：使用者 id 取自 `?user=<id>` 或標頭 `x-user-id`，預設 `1`；
  **全部集中在 `src/api.js` 的 `resolveUserId()`**，M3 換成 session cookie 時只改這一處。

### 優雅關機

收到 `SIGTERM` / `SIGINT` → 停止 tick 迴圈 → 寫回引擎狀態 → 關閉 HTTP → 關閉 SQLite。

---

## 模型摘要（對應規格章節）

### 價格（§4.1 / §4.2）

```
q      = μ + x + Σ T_i
P_base = exp(q)
P      = P_base × (1 + 0.2 × tanh(N / L))
```

| 層 | 參數 |
|----|------|
| `x` OU | `dx = −θx·dt + σ√dt·N(0,1)`，θ = 8e-6、σ = 1.4e-4、dt = 1 |
| `T_i` 事件暫態 | `dT = −λT·dt + σ_i√dt·N(0,1)`，`σ_i = |T_i(0)|·path_noise·√(2λ)` |
| 事件間隔 | 指數分布：結構 mean 10.5 天、重大 mean 1.5 h、新聞 mean 7.5 min |
| 事件幅度 | 結構 ±2～5%（100% 永久）、重大 ±1.5～4%（黏著 1.5～3%，永久 30～70%，半衰期 2～6 h，路徑噪音 0.5）、新聞 ±0.3～1%（半衰期 15～30 min，路徑噪音 0.25） |

`L = max(3,000,000, 0.001 × 最近 1,440 分鐘名目成交量)`，**只在分鐘邊界重算**。
`N` 以**開倉當下的名目固定**計（不隨價格重估）。

### 成交價（§4.3）

成交價一律取**本次交易完成後**的價格：

- 開多：先加部位 → 價被推高 → 買在 `P_post × (1 + 0.0002)`
- 平多：先移除部位 → 價被壓低 → 賣在 `P_post × (1 − 0.0002)`
- 開空 / 平空 對稱

因此「自己拉抬再自己平倉」必虧（衝擊 + 雙邊點差）。

### 帳戶（§5）

- 收入 35,000 milli-A / tick，`balance += 35,000 × (tick_count − settled_tick_id)`（延遲結算）
- 保證金 = 名目 ÷ 槓桿；維持保證金 = 名目 × 0.2%；強平距離 = 1/槓桿 − 0.2%
- 強平：浮虧 ≥ 保證金 − 維持保證金；**先收集全部觸發、再依序平倉並重算價格**
- 超額損失由可用餘額吸收，餘額可為負；欠款期間不能開新倉
- 持倉費（§5.5 v0.25）：多 2.6%/年（`rate_num = 26`）、空 0.9%/年（`rate_num = 9`），
  `fee_micro = floor(名目_milli × rate_num ÷ 8760)`（微 A），
  `fee_milli = floor((fee_micro + fee_remainder_micro) ÷ 1000)`，
  找零 `fee_remainder_micro = (fee_micro + fee_remainder_micro) % 1000`（**微 A**、整數），
  整點（`tick_count % 3600 === 0`）結算；10 萬名目做多 24 小時合計 **7.123 A**
- 最小名目 10,000 A；保證金級距 10 A；同時持倉上限 5 張
- 名目上限 `min(2L, 可用餘額 × 槓桿)`，單人總名目上限 `4L`

### 資料（§6.2，v0.25）

`users` / `accounts` / `positions` / `trades` / `rules` / `events` / `candles_1m` / `ledger` / `engine_state`
欄位完全依規格 v0.25；索引 `positions(user_id,status)`、`trades(user_id,tick_id)`、`ledger(user_id,tick_id)`。
金額為整數 milli-A、價格為整數 e4；**所有經濟時間欄位存 `tick_id`**（不用 wall clock）：

| 表 | 時間欄位 |
|----|---------|
| `users` | `created_at` = ISO 真實時間（M1 尚未寫 ISO，暫存 tick；M2 登入時補齊） |
| `accounts` | `settled_tick_id`、`last_settled_tick`、`created_at` |
| `positions` | `opened_tick`、`closed_tick` |
| `trades` / `events` / `ledger` | `tick_id` |
| `rules` | `created_tick`、`triggered_tick` |
| `candles_1m` | `started_at` = ISO（僅供前端時間軸；M1 先留 NULL） |

唯一的非毫 A 金額欄位是 `positions.fee_remainder_micro`（**微 A**，1 A = 1,000,000）——只存不足 1 毫 A
的持倉費找零，永不直接當餘額或損益。`engine_state(key, value_json)` 存 μ、x、各事件 T_i 與 RNG 狀態，
重啟原樣載回、不對 API 輸出。

---

## 實作選擇（規格未明處的預設值）

1. **`balance_milli` 語意**：= 現金餘額（可用餘額）。開倉即扣保證金，平倉時
   `現金 += 保證金 + 損益` → 等價於「餘額變化 = 實際損益」。權益 = 現金 + 在場保證金。
2. **分鐘切分**：`minute_id = ⌊(tick_count − 1) / 60⌋`，每 60 ticks 收線並寫一根
   `candles_1m`；`tick_id // 60` 與之相差至多一根，客戶端對齊時以伺服器 tick 為準（§7.6）。
3. **收入結算頻率**：規格寫「每 5 分鐘」，實作在**每 5 分鐘**（300 ticks）或**每次交易**時
   把 accrued 寫回 `accounts`；引擎狀態每分鐘存一次（較 `accounts` 表新，重啟以它為準）。
4. **四捨五入方向**：`roundHalfUp(x) = floor(x + 0.5)`（朝 +∞；−0.5 → 0）。
   損益一律由**整數 e4 進場/出場價**推導，因此重複結算不累積誤差。
5. **黏著型機率**：每次重大事件獨立抽 `U(1.5%, 3%)`；黏著時永久比例抽 `U(30%, 70%)`。
6. **事件文案池**：`config.js` 內建中性財經文案（依類型分池），僅供 `events` 表 `headline` 使用。
7. **分鐘邊界的成交歸屬**：交易發生在「某分鐘已封存、下一分鐘尚未開盤」的縫隙時
   （例如 tick 恰好是 60 的倍數），該筆成交量會記到**下一根** K 線（價格影響則從下一根
   K 線的 open 開始反映）。避免出現「已封存的 K 線被回頭改寫」與成交量遺失。
8. **額外產出**：`src/scenarios.js`（規格未要求，但 CLI 的 `scenario` 指令需要）、
   `Engine.resetAccount()`（情境用）、停損停利觸發（CLI 的 `--sl/--tp` 需要，M1 只做伺服器端觸發，
   不做 §6.3 的條件開倉規則——那是 M3）。

> v0.25 已對齊規格的兩項（原先列於本節，現已移除）：`engine_state` 表取代舊的 `kv` 額外表；
> `positions.fee_remainder_micro` 改為**整數微 A**，不再用 REAL 存毫 A 小數。

## 規格衝突與取捨（已知的 spec 內部矛盾）

| # | 衝突 | 本實作取捨 |
|---|------|-----------|
| A | §10「100 倍槓桿、**逆向 0.5%** 必觸發強平」vs §5.2 / §7.5「100× 強平距離 = 1/100 − 0.2% = **0.8%**」 | 採 **0.8%**（§5.2、D35、§7.5 三處一致；§10 該行是 v0.8 把維持保證金由 0.5% 改成 0.2% 時的殘留）。測試 6 因此驗證：逆向 0.5% → 只虧約 50% 保證金、**不**強平；逆向 ≥0.8% → 強平，且餘額變化 = 實際損益（誤差 0）、其他帳戶不受影響。 |
| B | §2.4「維持保證金 0.5%」vs §5.2 / D35「0.2%」 | 採 **0.2%**（D35 已定案，v0.8 更新）。 |
| C | §13 名詞表寫「維持保證金 = 名目的 0.5%」 | 同 B。 |
| D | §5.2 表格「100× 強平 0.8%」vs §5.2 表格「10× 9.8%」→ 皆為 `1/lev − 0.2%` | 一致，照 §5.2 公式實作。 |

## 測試

```bash
npm test
```

`node --test`（無框架、無 watch）。共 **31 個測試**：M1 的 15 個（規格要求 10 個 + 5 個補充）
＋ M2 的 16 個（REST / WebSocket）。

### M1（15 個）

| # | 測試 | 對應規格 |
|---|------|---------|
| 1 | 10 萬名目持倉費 24 小時合計 **7.123 A**（誤差 < 0.001 A、找零以微 A 累積） | §10 E / §5.5 |
| 2 | 價格衝擊上限 ±20%（tanh 飽和） | §4.1 |
| 3 | 開多 → 立刻平倉，淨損益 < 0 | §10 經濟 |
| 4 | 自推自賺：最大名目推高價格再平倉，淨損益 < 0 | §10 經濟 |
| 5 | 兩玩家對做，影響互相抵銷 | §10 經濟 |
| 6 | 100× 逆向 → 強平，只影響該單 | §10 經濟（見上表 A） |
| 7 | 4% 跳空 → 餘額為負、欠款期間不能開新倉 | §10 經濟 |
| 8 | 重啟後 `tick_id` 接續、停機期間不發收入 | §4.4 / §5.4 |
| 8b | schema 欄位名稱符合 v0.25（`engine_state` / `fee_remainder_micro` / `tick_id`…） | §6.2 |
| 9 | 60 ticks → 恰好一根 1 分 K，OHLC 正確 | §7.6 / §10 E |
| 10 | 10,000 次重大事件：黏著 1.5～3%、永久 30～70% | §10 事件模型 |
| E1 | P&L 四捨五入到毫 A、重複結算不累積誤差 | §10 E |
| E2 | 收入以 tick 計、停機不補發 | §5.4 |
| 10b | 結構事件 100% 永久、新聞事件無永久比例 | §4.2 |
| 10c | 同種子重播事件序列可重現 | §4.2 |

### M2（16 個，`test/api.test.js`）

| # | 測試 | 對應 contract |
|---|------|---------|
| A1 | `GET /healthz` → `ok` / `tick_id` / `uptime_s` | REST |
| A2 | `GET /api/state` → 起始餘額 100,000 A、market / account 欄位 | REST / M2 acceptance |
| A3 | `GET /api/config` → 槓桿、最小保證金、費率 | REST |
| A4 | `POST /api/open` 1,000 A × 10 → 10,000 A 名目 | M2 acceptance |
| A5 | `POST /api/close` → 立刻平倉負損益 | M2 acceptance |
| A6 | 拒絕原因為穩定機器字串（`invalid_side` / `invalid_leverage` / `insufficient_balance` / `not_found`） | REST |
| A7 | `GET /api/candles` → 最舊 → 最新、上限 600 | REST |
| A8 | `GET /api/events` → 最新 → 最舊、無 `type` / `permanent_share` | REST / §7.7 |
| A9 | 任何 API / WS payload 都不得出現 `type` / `permanent_share` | M2 acceptance |
| A10 | WS：連線立即收到 `snapshot`，之後每秒收到 `tick` | WS |
| A11 | WS：`order.open` → `order.filled`（回傳 `request_id`）；`order.close` 同；拒絕回 `order.rejected` | WS |
| A12 | WS：身分不符的訂單一律拒絕（`user_mismatch`） | WS |
| A13 | 靜態頁 `GET /` 回傳 `public/index.html`（無外部 CDN） | §9 |
| A14 | WS：真實 tick 迴圈定期推送 `tick`（`tick_id` 遞增） | WS / §4.4 |
| A15 | WS：新事件廣播 `event`（且不含 `type` / `permanent_share`） | WS / §7.7 |
| A16 | WS：強平只通知受影響的使用者 | WS |

測試 8、8b 與全部 M2 測試需要 `better-sqlite3`；若原生模組不可用會自動 **skip**
（M1 純邏輯測試仍會跑）。每個 M2 測試都使用**全新的暫存 DB**，且**不啟動真實 tick 迴圈**
（`buildServer({ live: false })`），需要時間推進時由測試手動呼叫 `engine.tick()`。

## 尚未包含（M3 範圍）

- Google 登入與 session（§6.1，M2 為臨時 `?user=` 認證）
- 手機版（§7.3；M2 只做桌機）
- 離線自動規則引擎與離線報告（§6.3、§6.4）
- 條件開倉規則、平倉後自動再下單（§7.5）
- 裝飾、排行榜、破產重整（post-alpha）
