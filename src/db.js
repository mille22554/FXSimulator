/**
 * 資料層（spec §6.2，v0.25）。
 *
 * - 9 張表完全依 §6.2 的欄位定義（含 v0.25 新增的 `engine_state`）。
 * - `engine_state(key, value_json)` 供 §4.4 的「重啟後恢復 tick_id / 市場狀態」使用，
 *   存放 μ、x、各事件 T_i 與 RNG 狀態（重啟原樣載回，不對 API 輸出）。
 * - `better-sqlite3` 以動態 import 載入，純邏輯測試在原生模組安裝失敗時仍可執行。
 *
 * 時間欄位（tick_id / created_tick / triggered_tick / opened_tick / closed_tick /
 * last_settled_tick）一律存 tick_id：經濟邏輯不得依賴 wall clock（§5.4）。
 * 唯一例外：`users.created_at` 是 ISO 真實時間；`candles_1m.started_at` 另存 ISO
 * （M1 先留 NULL，僅供前端時間軸）。
 */

import { MILLI_PER_A } from './config.js';

/** 建表（§6.2 v0.25 ＋ M3 擴充）；索引另外建（見 INDEXES_SQL） */
export const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  google_sub     TEXT UNIQUE,
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name   TEXT,
  avatar_url     TEXT,
  disabled       INTEGER NOT NULL DEFAULT 0,
  role           TEXT NOT NULL DEFAULT 'player',
  created_at     INTEGER NOT NULL DEFAULT 0,
  -- M3：better-auth 的使用者 id（ba_user.id，uuid 字串）→ 本地帳號的連結鍵
  ba_user_id     TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  user_id           INTEGER PRIMARY KEY,
  balance_milli     INTEGER NOT NULL DEFAULT 0,
  settled_tick_id   INTEGER NOT NULL DEFAULT 0,
  last_settled_tick INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT 0,
  -- M3（§6.4 離線報告）：上次連線的 tick、期間淨值高低點、上次連線時的淨值
  last_seen_tick    INTEGER NOT NULL DEFAULT 0,
  equity_high_milli INTEGER,
  equity_low_milli  INTEGER,
  equity_seen_milli INTEGER
);

CREATE TABLE IF NOT EXISTS positions (
  id                   INTEGER PRIMARY KEY,
  user_id              INTEGER NOT NULL,
  side                 TEXT NOT NULL,
  notional_milli       INTEGER NOT NULL,
  leverage             INTEGER NOT NULL,
  entry_price_e4       INTEGER NOT NULL,
  margin_milli         INTEGER NOT NULL,
  liq_price_e4         INTEGER NOT NULL,
  sl_price_e4          INTEGER,
  tp_price_e4          INTEGER,
  fee_remainder_micro  INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'open',
  opened_tick          INTEGER NOT NULL DEFAULT 0,
  closed_tick          INTEGER,
  close_price_e4       INTEGER,
  pnl_milli            INTEGER NOT NULL DEFAULT 0,
  rule_id              INTEGER
);

CREATE TABLE IF NOT EXISTS trades (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  position_id   INTEGER,
  kind          TEXT NOT NULL,
  price_e4      INTEGER NOT NULL,
  notional_milli INTEGER NOT NULL,
  fee_milli     INTEGER NOT NULL DEFAULT 0,
  tick_id       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rules (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  params_json       TEXT NOT NULL DEFAULT '{}',
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_tick      INTEGER NOT NULL DEFAULT 0,
  triggered_tick    INTEGER,
  -- M3（§6.3）：條件開倉規則的明確欄位（params_json 仍保留完整快照）
  side              TEXT NOT NULL DEFAULT 'long',
  trigger_price_e4  INTEGER NOT NULL DEFAULT 0,
  margin_a          INTEGER NOT NULL DEFAULT 0,
  leverage          INTEGER NOT NULL DEFAULT 10,
  sl_pct            REAL,
  tp_pct            REAL,
  -- 價格制（§7.5；sl_pct/tp_pct 僅保留給舊資料換算）
  sl_price_e4       INTEGER,
  tp_price_e4       INTEGER,
  status            TEXT NOT NULL DEFAULT 'active',
  armed_side        TEXT,
  last_error        TEXT,
  paused_reason     TEXT,
  last_notified_tick INTEGER,
  pending_tick      INTEGER,
  position_id       INTEGER
);

CREATE TABLE IF NOT EXISTS rule_events (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL,
  rule_id        INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  tick_id        INTEGER NOT NULL DEFAULT 0,
  side           TEXT,
  price_e4       INTEGER,
  notional_milli INTEGER,
  pnl_milli      INTEGER,
  reason         TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY,
  tick_id           INTEGER NOT NULL DEFAULT 0,
  headline          TEXT NOT NULL DEFAULT '',
  impact_jump       REAL NOT NULL DEFAULT 0,
  type              TEXT NOT NULL,
  permanent_share   REAL NOT NULL DEFAULT 0,
  decay_half_life   REAL
);

CREATE TABLE IF NOT EXISTS candles_1m (
  minute_id             INTEGER PRIMARY KEY,
  started_at            TEXT,
  open_e4               INTEGER NOT NULL,
  high_e4               INTEGER NOT NULL,
  low_e4                INTEGER NOT NULL,
  close_e4              INTEGER NOT NULL,
  base_close_e4         INTEGER NOT NULL,
  net_notional_milli    INTEGER NOT NULL DEFAULT 0,
  volume_notional_milli INTEGER NOT NULL DEFAULT 0,
  supply_a_milli        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  delta_milli INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  tick_id     INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS engine_state (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`;

/**
 * 索引（必須在建表 + 遷移**之後**才建立：
 * `idx_rules_user_status` 依賴 M3 新增的 `rules.status` 欄位）。
 */
export const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_positions_user_status ON positions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_user_tick_id  ON trades(user_id, tick_id);
CREATE INDEX IF NOT EXISTS idx_ledger_user_tick_id  ON ledger(user_id, tick_id);
CREATE INDEX IF NOT EXISTS idx_rules_user_status    ON rules(user_id, status);
CREATE INDEX IF NOT EXISTS idx_rule_events_user_tick ON rule_events(user_id, tick_id);
-- M3：better-auth user id 唯一（nullable → SQLite 允許多個 NULL）
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ba_user_id ON users(ba_user_id);
`;

/** 完整 schema（建表 + 索引）；供外部工具一次執行 */
export const SCHEMA_SQL = `${TABLES_SQL}\n${INDEXES_SQL}`;

/**
 * M3 的欄位遷移（§6.2 v0.25 的表已存在於線上 DB → `CREATE TABLE IF NOT EXISTS` 不會補欄位）。
 * 只補「缺」的欄位，既有資料與欄位名一律不動。
 */
export const MIGRATIONS = {
  accounts: {
    last_seen_tick: 'INTEGER NOT NULL DEFAULT 0',
    equity_high_milli: 'INTEGER',
    equity_low_milli: 'INTEGER',
    equity_seen_milli: 'INTEGER',
  },
  positions: {
    rule_id: 'INTEGER',
  },
  ledger: {
    source: "TEXT NOT NULL DEFAULT 'system'",
  },
  rules: {
    side: "TEXT NOT NULL DEFAULT 'long'",
    trigger_price_e4: 'INTEGER NOT NULL DEFAULT 0',
    margin_a: 'INTEGER NOT NULL DEFAULT 0',
    leverage: 'INTEGER NOT NULL DEFAULT 10',
    sl_pct: 'REAL',
    tp_pct: 'REAL',
    sl_price_e4: 'INTEGER',
    tp_price_e4: 'INTEGER',
    status: "TEXT NOT NULL DEFAULT 'active'",
    armed_side: 'TEXT',
    last_error: 'TEXT',
    paused_reason: 'TEXT',
    last_notified_tick: 'INTEGER',
    pending_tick: 'INTEGER',
    position_id: 'INTEGER',
  },
  // M3：better-auth session 與本地帳號的連結鍵
  users: {
    ba_user_id: 'TEXT',
  },
};

// ---------------------------------------------------------------------------
// 記憶體 store（測試用 / 沒有 better-sqlite3 時的 fallback）
// ---------------------------------------------------------------------------
export function createMemoryStore() {
  return {
    kind: 'memory',
    init() {},
    close() {},
    saveEngineState(state) {
      this._state = state;
    },
    loadEngineState() {
      return this._state ?? null;
    },
    saveCandle(c) {
      this._candles.set(c.minute_id, c);
    },
    loadCandles(limit = 100) {
      return [...this._candles.values()].sort((a, b) => a.minute_id - b.minute_id).slice(-limit);
    },
    loadLastCandle() {
      const all = this.loadCandles(Number.MAX_SAFE_INTEGER);
      return all.length ? all[all.length - 1] : null;
    },
    saveEvent(e) {
      this._events.push(e);
    },
    loadEvents(limit = 100) {
      return this._events.slice(-limit);
    },
    saveTrade(t) {
      this._trades.push(t);
    },
    loadTrades(limit = 100) {
      return this._trades.slice(-limit);
    },
    loadTradesRange(userId, fromTick = null, toTick = null) {
      return this._trades
        .filter((t) => t.userId === userId)
        .filter((t) => (fromTick == null ? true : t.ts > fromTick))
        .filter((t) => (toTick == null ? true : t.ts <= toTick))
        .map((t) => ({
          id: t.id,
          kind: t.kind,
          tick_id: t.ts ?? 0,
          price_e4: t.priceE4,
          notional_milli: t.notionalMilli,
        }))
        .sort((a, b) => a.tick_id - b.tick_id || a.id - b.id);
    },
    savePosition(p) {
      this._positions.set(p.id, { ...p });
    },
    updatePosition(p) {
      this._positions.set(p.id, { ...p });
    },
    loadPositions(status = null) {
      const all = [...this._positions.values()];
      return status ? all.filter((p) => p.status === status) : all;
    },
    saveAccount(a) {
      const key = a.user_id ?? a.userId;
      this._accounts.set(key, { ...(this._accounts.get(key) ?? {}), ...a });
    },
    loadAccounts() {
      return [...this._accounts.values()];
    },
    updateAccountMeta(userId, meta) {
      const key = userId ?? meta.user_id;
      const prev = this._accounts.get(key) ?? { user_id: key };
      this._accounts.set(key, {
        ...prev,
        user_id: key,
        balance_milli: meta.balanceMilli ?? prev.balance_milli ?? 0,
        settled_tick_id: meta.settledTickId ?? prev.settled_tick_id ?? 0,
        last_settled_tick: meta.lastSettledTick ?? prev.last_settled_tick ?? 0,
        last_seen_tick: meta.lastSeenTick ?? prev.last_seen_tick ?? 0,
        equity_high_milli: meta.equityHighMilli ?? null,
        equity_low_milli: meta.equityLowMilli ?? null,
        equity_seen_milli: meta.equitySeenMilli ?? null,
      });
      return this._accounts.get(key);
    },
    saveRule(rule) {
      this._rules.set(rule.id, { ...rule });
    },
    updateRule(rule) {
      this._rules.set(rule.id, { ...(this._rules.get(rule.id) ?? {}), ...rule });
    },
    loadRules(userId = null) {
      const all = [...this._rules.values()].sort((a, b) => a.id - b.id);
      return userId == null ? all : all.filter((r) => r.userId === userId);
    },
    loadRule(id) {
      return this._rules.get(id) ?? null;
    },
    saveRuleEvent(ev) {
      const id = this._ruleEventSeq++;
      this._ruleEvents.push({ ...ev, id });
      return id;
    },
    loadRuleEvents(userId, fromTick = null, toTick = null) {
      return this._ruleEvents
        .filter((e) => e.userId === userId)
        .filter((e) => (fromTick == null ? true : e.tickId > fromTick))
        .filter((e) => (toTick == null ? true : e.tickId <= toTick))
        .sort((a, b) => a.tickId - b.tickId || a.id - b.id);
    },
    saveUser(u) {
      const prev = this._users.get(u.id) ?? {};
      const next = { ...prev, ...u };
      // 已連結 Google 的欄位不被「預設值」覆蓋（saveUser 只帶 { id, created_at }）
      if (prev.ba_user_id && !u.ba_user_id) next.ba_user_id = prev.ba_user_id;
      if (prev.google_sub && !u.google_sub) next.google_sub = prev.google_sub;
      if (prev.email && !u.email) next.email = prev.email;
      if (prev.display_name && !u.display_name) next.display_name = prev.display_name;
      if (prev.avatar_url && !u.avatar_url) next.avatar_url = prev.avatar_url;
      if (prev.role && !u.role) next.role = prev.role;
      this._users.set(u.id, next);
    },
    loadUsers() {
      return [...this._users.values()];
    },
    // ---------------------------------------------- M3：better-auth 連結
    findUserById(id) {
      return this._users.get(id) ?? null;
    },
    findUserByBaUserId(baUserId) {
      for (const u of this._users.values()) if (u.ba_user_id === baUserId) return u;
      return null;
    },
    findUserByGoogleSub(sub) {
      if (!sub) return null;
      for (const u of this._users.values()) if (u.google_sub === sub) return u;
      return null;
    },
    linkBaUserId(userId, baUserId) {
      const u = this._users.get(userId);
      if (!u) return null;
      u.ba_user_id = baUserId;
      return u;
    },
    updateUserProfile(userId, { displayName, avatarUrl } = {}) {
      const u = this._users.get(userId);
      if (!u) return null;
      if (displayName) u.display_name = displayName;
      if (avatarUrl) u.avatar_url = avatarUrl;
      return u;
    },
    /** 記憶體 store 沒有 `ba_*` 表 → 拿不到 Google `sub` */
    getProviderAccountId() {
      return null;
    },
    createLocalUserWithAccount({
      baUserId = null,
      googleSub = null,
      email = null,
      displayName = null,
      avatarUrl = null,
      role = 'player',
      balanceMilli = 0,
      tick = 0,
    } = {}) {
      let nextId = 1;
      for (const u of this._users.keys()) if (u >= nextId) nextId = u + 1;
      const user = {
        id: nextId,
        ba_user_id: baUserId,
        google_sub: googleSub,
        email,
        email_verified: 1,
        display_name: displayName,
        avatar_url: avatarUrl,
        disabled: 0,
        role,
        created_at: new Date().toISOString(),
      };
      this._users.set(nextId, user);
      this._accounts.set(nextId, {
        user_id: nextId,
        balance_milli: balanceMilli,
        settled_tick_id: tick,
        last_settled_tick: tick,
        created_at: tick,
        last_seen_tick: tick,
      });
      return user;
    },
    saveLedger(l) {
      this._ledger.push(l);
    },
    loadLedger(limit = 100) {
      return this._ledger.slice(-limit);
    },
    _state: null,
    _candles: new Map(),
    _events: [],
    _trades: [],
    _positions: new Map(),
    _accounts: new Map(),
    _users: new Map(),
    _ledger: [],
    _rules: new Map(),
    _ruleEvents: [],
    _ruleEventSeq: 1,
  };
}

// ---------------------------------------------------------------------------
// SQLite store（WAL）
// ---------------------------------------------------------------------------
class SqliteStore {
  constructor(db) {
    this.kind = 'sqlite';
    this.db = db;
    this.init(); // 先建表，再準備 statement
    this.stmt = {
      upsertUser: db.prepare(
        `INSERT INTO users (id, google_sub, email, email_verified, display_name, avatar_url, disabled, role, created_at, ba_user_id)
         VALUES (@id, @google_sub, @email, @email_verified, @display_name, @avatar_url, @disabled, @role, @created_at, @ba_user_id)
         ON CONFLICT(id) DO UPDATE SET
           google_sub=CASE WHEN users.ba_user_id IS NOT NULL THEN users.google_sub ELSE excluded.google_sub END,
           email=CASE WHEN users.ba_user_id IS NOT NULL THEN users.email ELSE excluded.email END,
           email_verified=MAX(users.email_verified, excluded.email_verified),
           display_name=CASE WHEN users.ba_user_id IS NOT NULL THEN users.display_name ELSE excluded.display_name END,
           avatar_url=CASE WHEN users.ba_user_id IS NOT NULL THEN users.avatar_url ELSE excluded.avatar_url END,
           disabled=MAX(users.disabled, excluded.disabled),
           role=CASE WHEN excluded.role = 'player' THEN users.role ELSE excluded.role END,
           ba_user_id=COALESCE(users.ba_user_id, excluded.ba_user_id)`,
      ),
      upsertAccount: db.prepare(
        `INSERT INTO accounts (user_id, balance_milli, settled_tick_id, last_settled_tick, created_at)
         VALUES (@user_id, @balance_milli, @settled_tick_id, @last_settled_tick, @created_at)
         ON CONFLICT(user_id) DO UPDATE SET
           balance_milli=excluded.balance_milli, settled_tick_id=excluded.settled_tick_id,
           last_settled_tick=excluded.last_settled_tick`,
      ),
      insertPosition: db.prepare(
        `INSERT INTO positions (id, user_id, side, notional_milli, leverage, entry_price_e4, margin_milli,
                                liq_price_e4, sl_price_e4, tp_price_e4, fee_remainder_micro, status,
                                opened_tick, closed_tick, close_price_e4, pnl_milli, rule_id)
         VALUES (@id, @user_id, @side, @notional_milli, @leverage, @entry_price_e4, @margin_milli,
                 @liq_price_e4, @sl_price_e4, @tp_price_e4, @fee_remainder_micro, @status,
                 @opened_tick, @closed_tick, @close_price_e4, @pnl_milli, @rule_id)`,
      ),
      updatePosition: db.prepare(
        `UPDATE positions SET fee_remainder_micro=@fee_remainder_micro, status=@status,
           closed_tick=@closed_tick, close_price_e4=@close_price_e4, pnl_milli=@pnl_milli
         WHERE id=@id`,
      ),
      insertTrade: db.prepare(
        `INSERT INTO trades (id, user_id, position_id, kind, price_e4, notional_milli, fee_milli, tick_id)
         VALUES (@id, @user_id, @position_id, @kind, @price_e4, @notional_milli, @fee_milli, @tick_id)`,
      ),
      insertEvent: db.prepare(
        `INSERT INTO events (id, tick_id, headline, impact_jump, type, permanent_share, decay_half_life)
         VALUES (@id, @tick_id, @headline, @impact_jump, @type, @permanent_share, @decay_half_life)`,
      ),
      insertCandle: db.prepare(
        `INSERT INTO candles_1m (minute_id, started_at, open_e4, high_e4, low_e4, close_e4, base_close_e4,
                                 net_notional_milli, volume_notional_milli, supply_a_milli)
         VALUES (@minute_id, @started_at, @open_e4, @high_e4, @low_e4, @close_e4, @base_close_e4,
                 @net_notional_milli, @volume_notional_milli, @supply_a_milli)
         ON CONFLICT(minute_id) DO UPDATE SET
           open_e4=excluded.open_e4, high_e4=excluded.high_e4, low_e4=excluded.low_e4,
           close_e4=excluded.close_e4, base_close_e4=excluded.base_close_e4,
           net_notional_milli=excluded.net_notional_milli,
           volume_notional_milli=excluded.volume_notional_milli,
           supply_a_milli=excluded.supply_a_milli`,
      ),
      insertLedger: db.prepare(
        `INSERT INTO ledger (id, user_id, delta_milli, reason, tick_id, source)
         VALUES (@id, @user_id, @delta_milli, @reason, @tick_id, @source)`,
      ),
      insertRule: db.prepare(
        `INSERT INTO rules (id, user_id, kind, params_json, enabled, created_tick, triggered_tick,
                            side, trigger_price_e4, margin_a, leverage, sl_pct, tp_pct,
                            sl_price_e4, tp_price_e4, status,
                            armed_side, last_error, paused_reason, last_notified_tick, pending_tick, position_id)
         VALUES (@id, @user_id, @kind, @params_json, @enabled, @created_tick, @triggered_tick,
                 @side, @trigger_price_e4, @margin_a, @leverage, @sl_pct, @tp_pct,
                 @sl_price_e4, @tp_price_e4, @status,
                 @armed_side, @last_error, @paused_reason, @last_notified_tick, @pending_tick, @position_id)`,
      ),
      updateRule: db.prepare(
        `UPDATE rules SET enabled=@enabled, triggered_tick=@triggered_tick, side=@side,
           trigger_price_e4=@trigger_price_e4, margin_a=@margin_a, leverage=@leverage,
           sl_pct=@sl_pct, tp_pct=@tp_pct, sl_price_e4=@sl_price_e4, tp_price_e4=@tp_price_e4,
           status=@status, armed_side=@armed_side,
           last_error=@last_error, paused_reason=@paused_reason, last_notified_tick=@last_notified_tick,
           pending_tick=@pending_tick, position_id=@position_id, params_json=@params_json
         WHERE id=@id`,
      ),
      insertRuleEvent: db.prepare(
        `INSERT INTO rule_events (user_id, rule_id, kind, tick_id, side, price_e4,
                                  notional_milli, pnl_milli, reason)
         VALUES (@user_id, @rule_id, @kind, @tick_id, @side, @price_e4,
                 @notional_milli, @pnl_milli, @reason)`,
      ),
      updateAccountMeta: db.prepare(
        `INSERT INTO accounts (user_id, balance_milli, settled_tick_id, last_settled_tick, created_at,
                               last_seen_tick, equity_high_milli, equity_low_milli, equity_seen_milli)
         VALUES (@user_id, @balance_milli, @settled_tick_id, @last_settled_tick, 0,
                 @last_seen_tick, @equity_high_milli, @equity_low_milli, @equity_seen_milli)
         ON CONFLICT(user_id) DO UPDATE SET
           balance_milli=excluded.balance_milli, settled_tick_id=excluded.settled_tick_id,
           last_settled_tick=excluded.last_settled_tick,
           last_seen_tick=excluded.last_seen_tick, equity_high_milli=excluded.equity_high_milli,
           equity_low_milli=excluded.equity_low_milli, equity_seen_milli=excluded.equity_seen_milli`,
      ),
      upsertEngineState: db.prepare(
        `INSERT INTO engine_state (key, value_json) VALUES (@key, @value_json)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
      ),
      getEngineState: db.prepare(`SELECT value_json FROM engine_state WHERE key = ?`),
      lastCandle: db.prepare(`SELECT * FROM candles_1m ORDER BY minute_id DESC LIMIT 1`),
      candles: db.prepare(`SELECT * FROM candles_1m ORDER BY minute_id DESC LIMIT ?`),
      events: db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`),
      trades: db.prepare(`SELECT * FROM trades ORDER BY id DESC LIMIT ?`),
      positions: db.prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY id`),
      allPositions: db.prepare(`SELECT * FROM positions ORDER BY id`),
      accounts: db.prepare(`SELECT * FROM accounts`),
      accountById: db.prepare(`SELECT * FROM accounts WHERE user_id = ?`),
      users: db.prepare(`SELECT * FROM users`),
      userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
      userByBaUserId: db.prepare(`SELECT * FROM users WHERE ba_user_id = ?`),
      userByGoogleSub: db.prepare(`SELECT * FROM users WHERE google_sub = ?`),
      setBaUserId: db.prepare(`UPDATE users SET ba_user_id = ? WHERE id = ?`),
      updateUserProfile: db.prepare(
        `UPDATE users SET display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?`,
      ),
      insertLocalUser: db.prepare(
        `INSERT INTO users (google_sub, email, email_verified, display_name, avatar_url, disabled, role, created_at, ba_user_id)
         VALUES (@google_sub, @email, @email_verified, @display_name, @avatar_url, @disabled, @role, @created_at, @ba_user_id)`,
      ),
      insertLocalAccount: db.prepare(
        `INSERT INTO accounts (user_id, balance_milli, settled_tick_id, last_settled_tick, created_at, last_seen_tick)
         VALUES (@user_id, @balance_milli, @settled_tick_id, @last_settled_tick, @created_at, @last_seen_tick)`,
      ),
      ledger: db.prepare(`SELECT * FROM ledger ORDER BY id DESC LIMIT ?`),
      tradesRange: db.prepare(
        `SELECT id, kind, tick_id, price_e4, notional_milli FROM trades
         WHERE user_id = ? AND tick_id > ? AND tick_id <= ? ORDER BY tick_id, id`,
      ),
      rules: db.prepare(`SELECT * FROM rules ORDER BY id`),
      ruleById: db.prepare(`SELECT * FROM rules WHERE id = ?`),
      ruleEvents: db.prepare(
        `SELECT * FROM rule_events WHERE user_id = ? AND tick_id > ? AND tick_id <= ? ORDER BY tick_id, id`,
      ),
    };
  }

  init() {
    // 順序：建表 → 遷移（補 M3 欄位）→ 建索引（索引依賴新欄位）
    this.db.exec(TABLES_SQL);
    this.migrate();
    this.db.exec(INDEXES_SQL);
  }

  /** 補上 M3 新增的欄位（線上 DB 的 §6.2 v0.25 表已存在 → 不會被 CREATE TABLE 改動） */
  migrate() {
    for (const [table, columns] of Object.entries(MIGRATIONS)) {
      const existing = new Set(
        this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name),
      );
      for (const [name, decl] of Object.entries(columns)) {
        if (existing.has(name)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      }
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  saveEngineState(state) {
    this.stmt.upsertEngineState.run({ key: 'engine_state', value_json: JSON.stringify(state) });
  }

  loadEngineState() {
    const row = this.stmt.getEngineState.get('engine_state');
    return row ? JSON.parse(row.value_json) : null;
  }

  saveCandle(c) {
    this.stmt.insertCandle.run({
      minute_id: c.minute_id,
      started_at: c.started_at ?? null, // §6.2：ISO 時間軸（M1 尚未實作 → NULL）
      open_e4: c.open_e4,
      high_e4: c.high_e4,
      low_e4: c.low_e4,
      close_e4: c.close_e4,
      base_close_e4: c.base_close_e4,
      net_notional_milli: c.net_notional_milli,
      volume_notional_milli: c.volume_notional_milli,
      supply_a_milli: c.supply_a_milli,
    });
  }

  loadCandles(limit = 100) {
    return this.stmt.candles.all(limit).reverse();
  }

  loadLastCandle() {
    return this.stmt.lastCandle.get() ?? null;
  }

  saveEvent(e) {
    this.stmt.insertEvent.run({
      id: e.id,
      tick_id: e.ts ?? 0,
      headline: e.headline ?? '',
      impact_jump: e.pct ?? 0,
      type: e.type,
      permanent_share: e.permanentShare ?? 0,
      decay_half_life: e.halfLifeSec ?? null,
    });
  }

  loadEvents(limit = 100) {
    // JS 層維持 `ts` 欄位（DB 欄位為 tick_id）
    return this.stmt.events.all(limit).reverse().map((r) => ({ ...r, ts: r.tick_id }));
  }

  saveTrade(t) {
    this.stmt.insertTrade.run({
      id: t.id,
      user_id: t.userId,
      position_id: t.positionId ?? null,
      kind: t.kind,
      price_e4: t.priceE4,
      notional_milli: t.notionalMilli,
      fee_milli: t.feeMilli ?? 0,
      tick_id: t.ts ?? 0,
    });
  }

  loadTrades(limit = 100) {
    return this.stmt.trades.all(limit).reverse().map((r) => ({ ...r, ts: r.tick_id }));
  }

  /** M3：期間內的成交（離線報告判斷「是否發生強平」） */
  loadTradesRange(userId, fromTick = null, toTick = null) {
    return this.stmt.tradesRange.all(
      userId,
      fromTick == null ? -1 : fromTick,
      toTick == null ? Number.MAX_SAFE_INTEGER : toTick,
    );
  }

  savePosition(p) {
    this.stmt.insertPosition.run({
      id: p.id,
      user_id: p.userId,
      side: p.side,
      notional_milli: p.notionalMilli,
      leverage: p.leverage,
      entry_price_e4: p.entryPriceE4,
      margin_milli: p.marginMilli,
      liq_price_e4: p.liqPriceE4,
      sl_price_e4: p.slPriceE4 ?? null,
      tp_price_e4: p.tpPriceE4 ?? null,
      fee_remainder_micro: p.feeRemainderMicro ?? 0,
      status: p.status,
      opened_tick: p.openedAt ?? 0,
      closed_tick: p.closedAt ?? null,
      close_price_e4: p.closePriceE4 ?? null,
      pnl_milli: p.pnlMilli ?? 0,
      rule_id: p.ruleId ?? null,
    });
  }

  updatePosition(p) {
    this.stmt.updatePosition.run({
      id: p.id,
      fee_remainder_micro: p.feeRemainderMicro ?? 0,
      status: p.status,
      closed_tick: p.closedAt ?? null,
      close_price_e4: p.closePriceE4 ?? null,
      pnl_milli: p.pnlMilli ?? 0,
    });
  }

  loadPositions(status = 'open') {
    if (status === null) return this.stmt.allPositions.all();
    return this.stmt.positions.all();
  }

  saveAccount(a) {
    this.stmt.upsertAccount.run({
      user_id: a.user_id ?? a.userId,
      balance_milli: a.balance_milli ?? a.balanceMilli,
      settled_tick_id: a.settled_tick_id ?? a.settledTickId,
      last_settled_tick: a.last_settled_tick ?? a.settledTickId,
      created_at: a.created_at ?? 0,
    });
  }

  loadAccounts() {
    return this.stmt.accounts.all();
  }

  saveUser(u) {
    this.stmt.upsertUser.run({
      id: u.id,
      google_sub: u.google_sub ?? `local-${u.id}`,
      email: u.email ?? `local${u.id}@local`,
      email_verified: u.email_verified ?? 1,
      display_name: u.display_name ?? `玩家 ${u.id}`,
      avatar_url: u.avatar_url ?? null,
      disabled: u.disabled ?? 0,
      role: u.role ?? 'player',
      created_at: u.created_at ?? 0,
      ba_user_id: u.ba_user_id ?? null,
    });
  }

  loadUsers() {
    return this.stmt.users.all();
  }

  // ---------------------------------------------- M3：better-auth 連結
  /** 本地 users 列（依 id） */
  findUserById(id) {
    return this.stmt.userById.get(id) ?? null;
  }

  /** 依 better-auth user id（`ba_user.id`）找本地帳號 */
  findUserByBaUserId(baUserId) {
    if (!baUserId) return null;
    return this.stmt.userByBaUserId.get(baUserId) ?? null;
  }

  /** 依 Google `sub` 找本地帳號（唯一鍵） */
  findUserByGoogleSub(sub) {
    if (!sub) return null;
    return this.stmt.userByGoogleSub.get(sub) ?? null;
  }

  /** 把既有本地帳號連結到 better-auth user id */
  linkBaUserId(userId, baUserId) {
    this.stmt.setBaUserId.run(baUserId, userId);
    return this.stmt.userById.get(userId) ?? null;
  }

  /** 同步顯示名稱／頭像（email 可變，不在此更新） */
  updateUserProfile(userId, { displayName, avatarUrl } = {}) {
    this.stmt.updateUserProfile.run(displayName ?? null, avatarUrl ?? null, userId);
    return this.stmt.userById.get(userId) ?? null;
  }

  /**
   * 取 Google `sub`（存在 `ba_account.account_id`）。
   * 欄位名以 `PRAGMA table_info` 實際結果為準（snake_case / camelCase 皆可）。
   */
  getProviderAccountId(baUserId, providerId = 'google') {
    if (!baUserId) return null;
    try {
      const cols = this.db.prepare(`PRAGMA table_info(ba_account)`).all().map((c) => c.name);
      if (!cols.length) return null;
      const pick = (a, b) => (cols.includes(a) ? a : b);
      const accCol = pick('account_id', 'accountId');
      const provCol = pick('provider_id', 'providerId');
      const userCol = pick('user_id', 'userId');
      const row = this.db
        .prepare(
          `SELECT ${accCol} AS aid FROM ba_account WHERE ${userCol} = ? AND ${provCol} = ? LIMIT 1`,
        )
        .get(baUserId, providerId);
      return row?.aid ?? null;
    } catch {
      return null; // `ba_account` 尚未建立（migration 未跑）
    }
  }

  /**
   * 首次登入：建立本地 `users` + `accounts`（同一交易，100,000 A = 100,000,000 milli-A）。
   * @returns {object} 新建的 users 列
   */
  createLocalUserWithAccount({
    baUserId = null,
    googleSub = null,
    email = null,
    displayName = null,
    avatarUrl = null,
    role = 'player',
    balanceMilli = 0,
    tick = 0,
  } = {}) {
    const createdAt = new Date().toISOString();
    const run = this.db.transaction(() => {
      const info = this.stmt.insertLocalUser.run({
        google_sub: googleSub,
        email,
        email_verified: 1,
        display_name: displayName,
        avatar_url: avatarUrl,
        disabled: 0,
        role,
        created_at: createdAt,
        ba_user_id: baUserId,
      });
      const userId = Number(info.lastInsertRowid);
      this.stmt.insertLocalAccount.run({
        user_id: userId,
        balance_milli: balanceMilli,
        settled_tick_id: tick,
        last_settled_tick: tick,
        created_at: tick,
        last_seen_tick: tick,
      });
      return userId;
    });
    const userId = run();
    return this.stmt.userById.get(userId) ?? null;
  }

  saveLedger(l) {
    this.stmt.insertLedger.run({
      id: l.id,
      user_id: l.userId,
      delta_milli: l.deltaMilli,
      reason: l.reason,
      tick_id: l.ts ?? 0,
      source: l.source ?? 'system',
    });
  }

  loadLedger(limit = 100) {
    return this.stmt.ledger.all(limit).reverse().map((r) => ({ ...r, ts: r.tick_id }));
  }

  /** M3：帳號的離線報告 metadata（last_seen_tick / 期間淨值高低點） */
  updateAccountMeta(userId, meta) {
    const prev = this.stmt.accountById.get(userId);
    this.stmt.updateAccountMeta.run({
      user_id: userId,
      balance_milli: meta.balanceMilli ?? prev?.balance_milli ?? 0,
      settled_tick_id: meta.settledTickId ?? prev?.settled_tick_id ?? 0,
      last_settled_tick: meta.lastSettledTick ?? prev?.last_settled_tick ?? 0,
      last_seen_tick: meta.lastSeenTick ?? 0,
      equity_high_milli: meta.equityHighMilli ?? null,
      equity_low_milli: meta.equityLowMilli ?? null,
      equity_seen_milli: meta.equitySeenMilli ?? null,
    });
  }

  // ------------------------------------------------------------ 規則（M3）
  saveRule(rule) {
    this.stmt.insertRule.run(ruleRow(rule));
  }

  updateRule(rule) {
    this.stmt.updateRule.run(ruleRow(rule));
  }

  loadRules(userId = null) {
    const rows = this.stmt.rules.all();
    const list = userId == null ? rows : rows.filter((r) => r.user_id === userId);
    return list.map(rowToRule);
  }

  loadRule(id) {
    const row = this.stmt.ruleById.get(id);
    return row ? rowToRule(row) : null;
  }

  saveRuleEvent(ev) {
    const info = this.stmt.insertRuleEvent.run({
      user_id: ev.userId,
      rule_id: ev.ruleId,
      kind: ev.kind,
      tick_id: ev.tickId ?? 0,
      side: ev.side ?? null,
      price_e4: ev.priceE4 ?? null,
      notional_milli: ev.notionalMilli ?? null,
      pnl_milli: ev.pnlMilli ?? null,
      reason: ev.reason ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  loadRuleEvents(userId, fromTick = null, toTick = null) {
    const rows = this.stmt.ruleEvents.all(
      userId,
      fromTick == null ? -1 : fromTick,
      toTick == null ? Number.MAX_SAFE_INTEGER : toTick,
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      ruleId: r.rule_id,
      kind: r.kind,
      tickId: r.tick_id,
      side: r.side,
      priceE4: r.price_e4,
      notionalMilli: r.notional_milli,
      pnlMilli: r.pnl_milli,
      reason: r.reason,
    }));
  }
}

/** 規則物件 → SQLite 參數 */
function ruleRow(rule) {
  return {
    id: rule.id,
    user_id: rule.userId,
    kind: rule.kind,
    params_json: JSON.stringify(rule.params ?? {}),
    enabled: rule.enabled ? 1 : 0,
    created_tick: rule.createdTick ?? 0,
    triggered_tick: rule.triggeredTick ?? null,
    side: rule.side,
    trigger_price_e4: rule.triggerPriceE4,
    margin_a: rule.marginA,
    leverage: rule.leverage,
    sl_pct: rule.slPct ?? null,
    tp_pct: rule.tpPct ?? null,
    sl_price_e4: rule.slPriceE4 ?? null,
    tp_price_e4: rule.tpPriceE4 ?? null,
    status: rule.status,
    armed_side: rule.armedSide ?? null,
    last_error: rule.lastError ?? null,
    paused_reason: rule.pausedReason ?? null,
    last_notified_tick: rule.lastNotifiedTick ?? null,
    pending_tick: rule.pendingTick ?? null,
    position_id: rule.positionId ?? null,
  };
}

/** SQLite row → 規則物件 */
export function rowToRule(row) {
  // 價格制：新欄位優先；舊資料（只有 sl_pct/tp_pct）在讀取時換算成價格
  const legacySl = legacyStopPriceE4(row.trigger_price_e4, row.sl_pct, row.side, 'sl');
  const legacyTp = legacyStopPriceE4(row.trigger_price_e4, row.tp_pct, row.side, 'tp');
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    params: safeJson(row.params_json),
    enabled: !!row.enabled,
    createdTick: row.created_tick ?? 0,
    triggeredTick: row.triggered_tick ?? null,
    side: row.side,
    triggerPriceE4: row.trigger_price_e4,
    marginA: row.margin_a,
    leverage: row.leverage,
    // 舊百分比欄位（0.5 = 0.5%）：只作為 fallback 顯示，不再用於計算
    slPct: row.sl_pct ?? null,
    tpPct: row.tp_pct ?? null,
    slPriceE4: row.sl_price_e4 ?? legacySl,
    tpPriceE4: row.tp_price_e4 ?? legacyTp,
    status: row.status,
    armedSide: row.armed_side ?? null,
    lastError: row.last_error ?? null,
    pausedReason: row.paused_reason ?? null,
    lastNotifiedTick: row.last_notified_tick ?? null,
    pendingTick: row.pending_tick ?? null,
    positionId: row.position_id ?? null,
  };
}

/**
 * 舊百分比 → 價格（e4）。只在舊資料列（沒有 *_price_e4）時使用。
 * sl_pct / tp_pct 的單位是**百分比數字**（0.5 = 0.5%），以觸發價為基準換算。
 * @returns {number|null}
 */
function legacyStopPriceE4(refE4, pctPercent, side, kind) {
  const ref = Number(refE4);
  const pct = Number(pctPercent);
  if (!Number.isFinite(ref) || ref <= 0) return null;
  if (!Number.isFinite(pct) || pct <= 0) return null;
  const fraction = pct / 100;
  const long = side === 'long';
  // 停損在虧損方向、停利在獲利方向
  const below = kind === 'sl' ? long : !long;
  const price = below ? ref * (1 - fraction) : ref * (1 + fraction);
  const e4 = Math.round(price);
  return e4 > 0 ? e4 : null;
}

function safeJson(text) {
  try {
    return JSON.parse(text ?? '{}');
  } catch {
    return {};
  }
}

/**
 * 開啟 SQLite store（WAL 模式）。better-sqlite3 以動態 import 載入，
 * 因此原生模組缺失時，其他純邏輯測試仍可執行。
 */
export async function openSqliteStore(path = 'fxsim.db') {
  const mod = await import('better-sqlite3');
  const Database = mod.default ?? mod;
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const store = new SqliteStore(db);
  return store;
}

/** 用既有的 better-sqlite3 連線建立 store（與 better-auth 共用同一個連線 → 避免跨連線鎖） */
export function createSqliteStore(db) {
  return new SqliteStore(db);
}

/** 名目（A）→ milli */
export function notionalToMilli(a) {
  return Math.round(a * MILLI_PER_A);
}

export default { SCHEMA_SQL, createMemoryStore, openSqliteStore };
