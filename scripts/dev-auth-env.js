/**
 * 測試環境設定（`node --import ./scripts/test-env.js --test` 載入）。
 *
 * `DEV_AUTH=1` → 保留 M2 的 `?user=` / `x-user-id` 行為，
 * 讓既有的 51 個測試維持原樣（spec §6.1：正式環境才會擋未登入）。
 *
 * ⚠️ 每個測試檔案可用 `process.env.DEV_AUTH = '0'` 暫時關閉（見 test/auth.test.js）。
 */
process.env.DEV_AUTH = process.env.DEV_AUTH ?? '1';
