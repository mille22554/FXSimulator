# FXSimulator — M1（市場引擎 + 帳戶 + CLI）＋ M2（HTTP API + WebSocket）＋ M3（離線規則 + 離線報告 + Google 登入）

依 `FXSimulator-Spec.md` **v0.25** 實作：

- **M1 里程碑**：A/B 合成標的（CFD）的市場引擎、逐倉帳戶、強平與持倉費、SQLite 持久化、CLI 情境驗證。
- **M2 里程碑**：Fastify HTTP API、WebSocket 即時協定、每秒 tick 迴圈，以及 **桌機交易頁**（走勢圖、下單面板、持倉、新聞看板；無建置步驟、無 CDN）。
- **M3 里程碑（後端）**：**離線自動規則引擎**（§6.3 條件開倉，一次性、每帳號 2 條、0.1% 變差滑價、強平暫停）＋ **離線報告**（§6.4 收入 / 淨值高低 / 觸發明細 / 是否強平）＋ **Google 登入**（§6.1，`better-auth` cookie session）。

- 純 ESM JavaScript（Node 20+），**無 TypeScript、無建置步驟**
- 唯一原生相依套件：`better-sqlite3`（以動態 `import()` 載入，純邏輯測試可在原生模組缺席時執行）；
  其餘為純 JS：`fastify`、`@fastify/websocket`、`@fastify/static`、`ws`、`better-auth`
- 所有隨機性走 `src/rng.js`（mulberry32），**同種子可完全重播**
- **經濟邏輯不使用 wall clock**：`tick_id` 是唯一真相

---

## 快速開始

```bash
npm install          # 需要 node-gyp（Python + C++ 工具鏈）才能建置 better-sqlite3
npm test             # node --import ./scripts/dev-auth-env.js --test（68 個測試）
npm start            # 啟動 HTTP + WebSocket 伺服器（127.0.0.1:2641）
node src/cli.js init
npm run migrate:auth # 建立 / 補齊 better-auth 的 ba_* 資料表
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
| `src/db.js` | §6.2 schema（WAL）、記憶體 store 與 SQLite store、save/load、**M3 欄位遷移** |
| `src/engine.js` | tick 協調：事件+OU、分鐘 K 線、強平檢查、持久化；M2 加 `onEvent` / `onLiquidation` / `onPositionClosed` 通知鉤子；**M3** 加規則成交、期間淨值高低點追蹤 |
| `src/serialize.js` | **M2**：唯一對外輸出的序列化層（狀態 / tick / 持倉 / K 線 / 事件；事件永不輸出 `type`、`permanent_share`）；**M3** 加 `rules` |
| `src/api.js` | **M2**：REST 路由（`/healthz`、`/api/*`）＋ WebSocket `/ws` 協定處理；**M3** 加 `/api/rules`、`/api/report` 與 `rule.upsert` / `rule.delete`、**`/api/me`**（session → 本地使用者） |
| `src/auth.js` | **M3**：`better-auth` 實例（Google provider、`ba_*` 表、`trustedOrigins`、每 IP 每日 3 次註冊上限）＋ `/api/auth/*` 掛載 |
| `src/identity.js` | **M3**：session → 本地 `users.id`（`resolveUserId()`／`resolveLocalUser()`）、`DEV_AUTH` 旁路開關、`AuthError`（401 / 403） |
| `src/live.js` | **M2**：live hub（連線登錄簿、每秒 tick 廣播、事件廣播、強平通知、漂移校正 tick 迴圈）；**M3** 加規則通知 |
| `src/server.js` | **M2**：Fastify app（websocket + 靜態檔）、listen、優雅關機 |
| `src/rules.js` | **M3**：條件開倉規則引擎（觸發判定、下一 tick 成交、變差滑價、失敗重試與冷卻、強平暫停、規則事件） |
| `src/report.js` | **M3**：離線報告（`last_seen_tick`、收入、淨值高低、觸發明細、是否強平） |
| `src/pct.js` | **M3**：`sl_pct` / `tp_pct` 百分比解析（M2 下單與 M3 規則共用） |
| `src/scenarios.js` | §10 驗收情境（roundtrip / pump / liquidation / gap / opposing） |
| `src/cli.js` | CLI：`init` `status` `tick` `open` `close` `candles` `events` `scenario` `reset` |
| `scripts/migrate-auth.js` | **M3**：`getMigrations(auth.options).runMigrations()` → 建立 / 補齊 `ba_user` `ba_session` `ba_account` `ba_verification` ＋ `users.ba_user_id` |
| `scripts/dev-auth-env.js` | 測試用（`node --import`）：設定 `DEV_AUTH=1` |
| `public/` | **M2**：桌機交易頁（`index.html`、`styles.css`、`js/`；含 `?mock=1` 模擬模式） |
| `test/api.test.js` | **M2**：REST + WebSocket 驗收（`fastify.inject` ＋ `ws`） |
| `test/rules.test.js` | **M3**：規則 + 離線報告驗收（20 個） |
| `test/auth.test.js` | **M3**：Google 登入 / session 驗收（16 個；**不真的打 Google**） |


## 前端（M2 桌機）

- `npm start` 後開 `http://127.0.0.1:2641/`（nginx 上為 `https://morowin.win/FXSimulator/`）。
- `?mock=1`：不連伺服器，用內建模擬資料預覽 UI（方便截圖與設計檢查）。
- `?user=1`：M2 臨時使用者；**M3 起僅在 `DEV_AUTH=1`（非 production）時有效**，
  正式環境一律以 Google session 為準。
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
| GET | `/api/me` | **M3**：`{ user: { id, email, name, avatar_url, role }, dev_auth }`；未登入 → 401 |
| GET | `/api/state?user=1` | 完整狀態（market / account / positions / candles / events） |
| GET | `/api/candles?limit=60` | 1 分 K，**最舊 → 最新**，上限 600 |
| GET | `/api/events?limit=100` | 事件，**最新 → 最舊**；**永不**含 `type` / `permanent_share` |
| POST | `/api/open` | `{ side, margin_a, leverage, sl_pct?, tp_pct? }` → `{ ok, position, fill }` |
| POST | `/api/close` | `{ position_id }` → `{ ok, exit_price_e4, pnl_milli }` |
| GET | `/api/rules?user=1` | **M3**：`{ max_active: 2, rules: [Rule] }` |
| POST | `/api/rules` | **M3**：`{ side, trigger_price_e4, margin_a, leverage, sl_pct?, tp_pct?, confirm? }` → `{ ok, rule }` |
| PATCH | `/api/rules/:id` | **M3**：`{ enabled }`（或改參數）→ `{ ok, rule }` |
| DELETE | `/api/rules/:id` | **M3**：取消規則 → `{ ok, rule }` |
| GET | `/api/report?user=1` | **M3**：離線報告（`scope=live` 可強制用目前的 `last_seen_tick` 往後算） |
| POST | `/api/report/ack` | **M3**（選用）：把 `last_seen_tick` 移到現在 → `{ ok: true }`（使用者可放 query 或 body 的 `user`） |

### M3 穩定原因字串

| 情境 | 原因 |
|------|------|
| 建立規則被拒 | `max_active_rules` / `trigger_too_close` / `invalid_trigger` / `invalid_margin` / `invalid_leverage` / `invalid_side` / `insufficient_margin` / `sl_invalid` / `tp_invalid` |
| 編輯 / 取消 | `not_found` / `rule_not_active`（已觸發或已取消的規則不得重新啟用） |
| 成交失敗（跳過） | `insufficient_balance` / `max_positions` / `debt_no_open` / `invalid_margin` / `insufficient_margin` / `sl_too_close` / `sl_beyond_liq` / `tp_invalid` |

### WebSocket `/ws?user=1`

- 伺服器 → 客戶端：`snapshot`（連線即送）｜`tick`（每秒）｜`order.filled` / `order.rejected`
  （回傳 `request_id`）｜`liquidation`（只送受影響的使用者）｜`event`｜`pong`
  ｜**M3**：`rule.updated` / `rule.triggered` / `rule.skipped`
- 客戶端 → 伺服器：`order.open`｜`order.close`｜`ping`｜**M3**：`rule.upsert` / `rule.delete`
- 重連後伺服器會重新送 `snapshot`，前端以 `snapshot` 覆蓋本地狀態。
- **M3 規則訊息細節**：
  - `rule.upsert` 的 `data` 可帶 `user` 欄位（會被**忽略**，身分只認連線與頂層 `user`）；
    成功 → 廣播 `rule.updated`（帶 `request_id`），失敗 → `rule.rejected`（帶 `reason`）。
  - `rule.delete` 的 `data` 為 `{ rule_id }`；成功 → `rule.updated`（`status='cancelled'`）。
  - **編輯規則＝先 `DELETE` 再 `POST`**（已取消的規則不佔 2 條額度），沒有另外的編輯端點。
  - `snapshot.rules[]` 與 `GET /api/state` 的 `rules[]` 形狀相同（contract「Rule shape」）。

---

## M3 離線自動規則（§6.3）與離線報告（§6.4）

### 條件開倉規則（`conditional_open`）

- **一次性**：成功成交後 `status='triggered'`，永不再次觸發，且**不佔** 2 條額度。
- **每帳號最多 2 條「啟用中」（`status='active'`）** 的規則；已觸發 / 已取消不計。
- **方向**在建立時決定（`armed_side`）：觸發價 > 現價 → `above`（`price >= trigger` 觸發）；
  觸發價 < 現價 → `below`（`price <= trigger` 觸發）。
- **觸發判定**用 tick 的 last price；**成交在下一 tick**，成交價 = 成交 tick 的市價，
  **0.1% 滑價只在變差時加**（買：next > trigger → ×1.001；賣：next < trigger → ×0.999）。
- 規則開倉的 **SL / TP 以實際成交價重算**；成交價已穿過 SL → **立刻平倉**。
- **每 tick 執行順序**：強平 → 停損／停利 → 規則成交（§6.3）。
- **成交失敗**（餘額不足 / 持倉滿 / 欠款…）→ **不自動停用**：回到 `active` + `last_error`，
  同一規則 **5 分鐘（300 ticks）最多通知一次**。
- **強平 → 暫停**該使用者的所有啟用中規則（`status='paused'`、`paused_reason='liquidation'`），
  需手動重新啟用（`PATCH { enabled: true }` → `active`、`last_error=null`）。
- 觸發價已在現價（或差 < 0.05%）→ 建立時回 `trigger_too_close`；
  玩家確認後可帶 `confirm: true` 建立。

### 規則狀態機

```
create ──► active ──觸發──► triggered（一次性，結束）
             │  ▲
      強平暫停 │  │ 手動重新啟用
             ▼  │
          paused ─┘
   （任何狀態）── DELETE ──► cancelled
```

### 離線報告（`GET /api/report`）

- 區間 = `[last_seen_tick, now]`；`last_seen_tick` 存在 `accounts` 表，**WS 連線時更新**
  （斷線時也會更新 → 離線期間從斷線那一刻算起）。
- WS 連線的那一刻會先把「剛結束的離線期間」算好並快取 → 玩家在線時仍看得到登入前的報告；
  `POST /api/report/ack`（選用）會把 `last_seen_tick` 移到現在。
- 欄位：`since_tick` `until_tick` `offline_seconds`（1 tick = 1 秒）
  `income_milli`（35,000 milli-A × tick 數）`equity_start_milli` `equity_end_milli`
  `equity_high_milli` `equity_low_milli` `liquidated` `triggers[]`。
- `triggers[]` 由舊到新，`kind` ∈ `open|sl|tp|liquidation|skipped`（`skipped` 另帶 `reason`）。

### M3 資料表擴充（§6.2 v0.25 欄位全部保留）

| 表 | 新增 |
|----|------|
| `rules` | `side` `trigger_price_e4` `margin_a` `leverage` `sl_pct` `tp_pct` `status` `armed_side` `last_error` `paused_reason` `last_notified_tick` `pending_tick` `position_id`（`params_json` 仍保留完整快照） |
| `rule_events` | 新表：`id, user_id, rule_id, kind, tick_id, side, price_e4, notional_milli, pnl_milli, reason` |
| `accounts` | `last_seen_tick` `equity_high_milli` `equity_low_milli` `equity_seen_milli` |
| `positions` | `rule_id`（部位由哪條規則開出；`null` = 玩家手動） |
| `ledger` | `source`（規則開倉的相關分錄標記為 `rule`） |

> 線上既有 DB 不需重建：啟動時會自動 `ALTER TABLE` 補上上表的新欄位（`src/db.js` 的 `MIGRATIONS`）。

### 單位與認證（M3：session 制）

- 金額一律**整數 milli-A**（`_milli`）、價格一律**整數 e4**（`_e4`）、百分比為小數比例。
- `sl_pct` / `tp_pct` 依 contract 請求範例以**百分比數字**解讀（`0.5` = 0.5%）；
  若百分比解讀違反引擎限制而小數比例解讀合法，則自動改採小數比例（相容兩種前端寫法）。
- **M3 起**：使用者 id 由 `src/identity.js` 的 `resolveUserId()` 解析（**唯一接點**）：
  - 正式環境（`NODE_ENV=production`）：better-auth session → 本地 `users.id`；
    無 session → **401**；`users.disabled = 1` → **403**。
  - 開發環境（`NODE_ENV` 未設為 production）且 `DEV_AUTH=1`（預設開啟，`DEV_AUTH=0` 關閉）：
    保留 M2 的 `?user=<id>` / `x-user-id` 旁路（僅供本機開發與測試）。

---

## M3 Google 登入（better-auth，§6.1）

### 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `GOOGLE_CLIENT_ID` | — | GCP OAuth Client（Web application） |
| `GOOGLE_CLIENT_SECRET` | — | 同上 |
| `BETTER_AUTH_SECRET` | — | **正式環境必填**（≥ 32 字元；未設 → 啟動直接失敗） |
| `BETTER_AUTH_BASE_URL` | `https://morowin.win` | better-auth 的 `baseURL`，**只能放 origin**（不可含 `/FXSimulator`） |
| `TRUSTED_ORIGINS` | — | 額外允許的 origin（逗號分隔） |
| `ADMIN_EMAILS` | — | 命中者 `users.role = 'admin'`（逗號分隔） |
| `NODE_ENV` | — | 正式環境**必須** `production`（否則 `DEV_AUTH` 旁路可用） |
| `DEV_AUTH` | 開發時 `1` | `0` 關閉 `?user=` 旁路；**production 一律忽略** |

> `.env` **不可 commit**（已在 `.gitignore` 的 `*.db` 之列者請自行加 `.env`）。

### 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| ANY | `/api/auth/*` | better-auth 路由（`sign-in/social`、`callback/google`、`sign-out`、`get-session`…） |
| GET | `/api/me` | `{ user: { id, email, name, avatar_url, role }, dev_auth }`；無 session → **401** `{ error: 'unauthorized' }`；`disabled` → **403** |

登入（前端）：

```js
const r = await fetch('/api/auth/sign-in/social', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ provider: 'google', callbackURL: location.href }),
});
const { url, redirect } = await r.json();
if (redirect) location.href = url;
```

登出：`POST /api/auth/sign-out`（`credentials: 'include'`）→ 重整。

### 本地帳號連結（§6.2）

- better-auth 自己的表：`ba_user` / `ba_session` / `ba_account` / `ba_verification`
  （**不要**把 better-auth 指向既有的 `accounts` 表 —— 那是資產表，`user_id` 是 INTEGER）。
- 本地 `users` 新增 `ba_user_id TEXT`（unique index `idx_users_ba_user_id`，可空）
  ＋既有的 `google_sub`（UNIQUE）。
- **唯一鍵是 Google `sub`**（email 可變）：
  1. 先用 `users.ba_user_id` 找；
  2. 找不到就用 `ba_account.accountId`（Google `sub`）找 `users.google_sub` → 找到就**連結**（不另建角色）；
  3. 再找不到 → **建立** `users` ＋ `accounts`（`balance_milli = 100,000,000` = 100,000 A），
     同一個交易（transaction）內完成；之後不再發放。
- 只接受 `email_verified = true` 的 Google 帳號（`user.validateUserInfo` 檢查原始 profile）。
- `users.disabled = 1` → 403。

### 註冊次數限制

- 每 IP 每日最多 **3 次**「開始註冊／登入」（`POST /api/auth/sign-in/social`）。
- IP 判定順序：`CF-Connecting-IP` → `X-Real-IP` → `X-Forwarded-For[0]`。
  ⚠️ nginx 的 `X-Real-IP` 是 cloudflared 的來源 IP（不是玩家 IP），**真實判定靠 Cloudflare 注入的 `CF-Connecting-IP`**。
- 計數存在行程記憶體（單 process；重啟歸零）。

### nginx 必要設定

```nginx
location /FXSimulator/ {
    proxy_pass http://127.0.0.1:2641/;
    proxy_http_version 1.1;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;      # 建議（CF-Connecting-IP 才是真實 IP）
    # Origin / CF-Connecting-IP 由 nginx 預設原樣轉送

    proxy_buffering off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

- Google redirect URI（**必須完全一致**）：
  `https://morowin.win/FXSimulator/api/auth/callback/google`
- Cookie：`Path=/`（nginx 剝掉 `/FXSimulator/` 前綴）、`HttpOnly`、`SameSite=Lax`、
  `Secure`（僅 production）。

### 部署順序

```bash
# 1. 載入環境變數（正式機）
set -a; . /opt/fxsimulator/.env; set +a

# 2. 跑 migration（必須在開流量前完成）
node scripts/migrate-auth.js /opt/fxsimulator/fxsim.db

# 3. 啟動服務（systemd 需設 NODE_ENV=production）
systemctl restart fxsim
```

> `better-auth` 1.7.3+ 會驗證 schema；缺表時請求會直接失敗。
> 伺服器啟動時也會自動跑一次（冪等）；設 `FXSIM_AUTO_MIGRATE=0` 可關閉
> （或 `buildServer({ migrateAuth: false })`）。

---

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

`node --import ./scripts/dev-auth-env.js --test`（無框架、無 watch）。共 **68 個測試**：
M1 的 15 個（規格要求 10 個 + 5 個補充）＋ M2 的 16 個（REST / WebSocket）
＋ M3 的 20 個（規則與離線報告）＋ M3 的 17 個（Google 登入 / session）。
測試時 `DEV_AUTH=1`（由 `scripts/dev-auth-env.js` 注入），讓既有的 51 個測試維持 M2 的 `?user=` 行為。

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

### M3（20 個，`test/rules.test.js`）

| # | 測試 | 對應 contract |
|---|------|--------------|
| R1 | 每帳號最多 2 條啟用中規則（第 3 條 → `max_active_rules`；取消後可再建立；額度 per user） | M3 acceptance |
| R2 | 觸發判定用 tick 的 last price；成交在**下一 tick**；一次性不重複觸發 | §6.3 / §10 |
| R3a | 買進：下一 tick 價格高於觸發價才加 0.1% 滑價 | §6.3 / §10 |
| R3b | 買進：下一 tick 價格低於觸發價 → 照該價成交 | §6.3 / §10 |
| R3c | 賣出：下一 tick 價格低於觸發價才減 0.1%；高於則照價成交 | §6.3 / §10 |
| R4 | 成交失敗 → 規則維持 `active` + `last_error`；通知每 5 分鐘最多一次 | §6.3 / §10 |
| R5 | 強平暫停所有啟用中規則；手動重新啟用可恢復 | §6.3 / §10 |
| R6 | 離線報告形狀（收入 / 淨值高低 / 觸發明細 / 是否強平） | §6.4 |
| R6b | 報告記錄 SL 平倉 | §6.4 |
| R6c | WS 連線會產生離線報告（`last_seen_tick` 隨連線更新） | §6.4 |
| R7 | REST：`GET/POST/PATCH/DELETE /api/rules`（穩定原因字串） | REST |
| R7b | `GET /api/state` 的 snapshot 含 `rules` | WS snapshot |
| R8 | WS：`rule.upsert` / `rule.delete` / `rule.updated` / `rule.triggered` | WS |
| R8b | WS：成交失敗 → `rule.skipped`（5 分鐘內不重複） | WS |
| R9 | 觸發價離現價 < 0.05% → `trigger_too_close`（`confirm: true` 可建立） | §6.3 |
| R10 | schema：M3 新增欄位與 `rule_events` 表（§6.2 v0.25 欄位不動） | §6.2 |
| R10b | 遷移：既有 M2 schema 開啟後自動補上 M3 欄位 | 部署 |
| R10c | 重啟後規則與規則事件都還在；規則開倉的 ledger `source='rule'` | §4.4 / §6.2 |
| R11 | `POST /api/report/ack { user }` → `{ ok: true }`，`last_seen_tick` 前移 | UI 整合 |
| R11b | WS `rule.upsert`：`data` 內的 `user` 欄位被忽略；頂層 `user` 不符仍拒絕 | UI 整合 |

測試 8、8b 與全部 M2 測試需要 `better-sqlite3`；若原生模組不可用會自動 **skip**
（M1 純邏輯測試仍會跑）。每個 M2 測試都使用**全新的暫存 DB**，且**不啟動真實 tick 迴圈**
（`buildServer({ live: false })`），需要時間推進時由測試手動呼叫 `engine.tick()`。

### M3 認證（17 個，`test/auth.test.js`）

| # | 測試 | 對應規格 |
|---|------|---------|
| G1 | 未登入 `GET /api/state` → 401（`DEV_AUTH=0`） | §10 登入與註冊 |
| G2 | 未登入 `GET /api/me` → 401 | §6.1 / 前端啟動流程 |
| G3 | 未登入 `POST /api/open` → 401 | §6.1 |
| G4 | `DEV_AUTH=1` → `GET /api/state?user=1` → 200（既有測試行為） | §8.2 |
| G5 | `DEV_AUTH=1` → `GET /api/me` 回 `dev_auth: true` | 前端啟動流程 |
| G6 | `devAuthEnabled()`：production 一律 false、`DEV_AUTH=0` → false | §6.1 |
| G7 | WS：未登入 → `close(1008)` | §8.1 |
| G8 | WS：`DEV_AUTH=1` → 連線成功並收到 `snapshot` | §8.1 |
| G9 | better-auth migration 冪等 ＋ `ba_*` 四張表存在 | §6.2 / 部署 |
| G10 | `users.ba_user_id` 欄位 ＋ unique index 存在 | §6.2 |
| G11 | 首次 Google 登入 → 建立本地 `users` ＋ `accounts`（100,000 A）；再次登入不重複發放 | §6.2 / §10 |
| G12 | 既有本地帳號（`google_sub`）→ 登入時被連結，不另建角色 | §6.1 |
| G13 | `users.disabled = 1` → 403 | §6.1 / §10 |
| G14 | session 有效時回本地 `users.id`（整數），不是 better-auth 的 uuid | §6.2 |
| G15 | `/api/auth/get-session` 無 cookie → `null` | §6.1 |
| G16 | 每 IP 每日「開始註冊/登入」上限 3 次 | §6.1 / §10 |
| G17 | 第 4 次「開始註冊/登入」→ **429**（上限真的擋得住） | §6.1 / §10 |

> **不真的打 Google**：session 相關的測試用 stub（假的 `auth.api.getSession`），
> 或直接插入 `ba_user` / `ba_account` 列模擬「已登入」狀態。

## 尚未包含（M3 剩餘範圍）

- 手機版 UI（§7.3；M2 只做桌機）—— M3 **後端**已完成，前端由另一條 lane 處理
- 登入頁 UI（§7.1 / §10「未登入顯示登入頁」）—— 前端由另一條 lane 處理
- 條件平倉、時間到平倉、移動停損（§6.3，M3 只做條件開倉）
- 排行榜、破產重整（post-alpha）
