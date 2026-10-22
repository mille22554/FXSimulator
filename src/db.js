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
  created_at     INTEGER NOT NULL DEFAULT 0
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
    status: "TEXT NOT NULL DEFAULT 'active'",
    armed_side: 'TEXT',
    last_error: 'TEXT',
    paused_reason: 'TEXT',
    last_notified_tick: 'INTEGER',
    pending_tick: 'INTEGER',
    position_id: 'INTEGER',
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
      this._users.set(u.id, { ...u });
    },
    loadUsers() {
      return [...this._users.values()];
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
        `INSERT INTO users (id, google_sub, email, email_verified, display_name, avatar_url, disabled, role, created_at)
         VALUES (@id, @google_sub, @email, @email_verified, @display_name, @avatar_url, @disabled, @role, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           google_sub=excluded.google_sub, email=excluded.email, email_verified=excluded.email_verified,
           display_name=excluded.display_name, avatar_url=excluded.avatar_url, disabled=excluded.disabled,
           role=excluded.role`,
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
                            side, trigger_price_e4, margin_a, leverage, sl_pct, tp_pct, status,
                            armed_side, last_error, paused_reason, last_notified_tick, pending_tick, position_id)
         VALUES (@id, @user_id, @kind, @params_json, @enabled, @created_tick, @triggered_tick,
                 @side, @trigger_price_e4, @margin_a, @leverage, @sl_pct, @tp_pct, @status,
                 @armed_side, @last_error, @paused_reason, @last_notified_tick, @pending_tick, @position_id)`,
      ),
      updateRule: db.prepare(
        `UPDATE rules SET enabled=@enabled, triggered_tick=@triggered_tick, side=@side,
           trigger_price_e4=@trigger_price_e4, margin_a=@margin_a, leverage=@leverage,
           sl_pct=@sl_pct, tp_pct=@tp_pct, status=@status, armed_side=@armed_side,
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
    });
  }

  loadUsers() {
    return this.stmt.users.all();
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
    slPct: row.sl_pct ?? null,
    tpPct: row.tp_pct ?? null,
    status: row.status,
    armedSide: row.armed_side ?? null,
    lastError: row.last_error ?? null,
    pausedReason: row.paused_reason ?? null,
    lastNotifiedTick: row.last_notified_tick ?? null,
    pendingTick: row.pending_tick ?? null,
    positionId: row.position_id ?? null,
  };
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
  const store = new SqliteStore(db);
  return store;
}

/** 名目（A）→ milli */
export function notionalToMilli(a) {
  return Math.round(a * MILLI_PER_A);
}

export default { SCHEMA_SQL, createMemoryStore, openSqliteStore };
