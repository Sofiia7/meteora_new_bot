import Database from 'better-sqlite3';
import path from 'path';
import { logger } from './logger';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    // DB_PATH позволяет тестам использовать ':memory:' и переносить БД без правки кода.
    const dbPath = process.env['DB_PATH'] ?? path.resolve(process.cwd(), 'data/bot.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    logger.info('SQLite database initialized');
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT UNIQUE NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      market_cap REAL,
      volume_24h REAL,
      price_usd REAL,
      ath REAL,
      discovered_at INTEGER NOT NULL DEFAULT (unixepoch()),
      security_passed INTEGER,
      security_warnings TEXT
    );

    CREATE TABLE IF NOT EXISTS watched_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      status TEXT NOT NULL DEFAULT 'watching'
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      fee_bps INTEGER NOT NULL,
      bin_step INTEGER NOT NULL,
      entry_price REAL NOT NULL,
      sol_amount REAL NOT NULL,
      position_pubkey TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      opened_at INTEGER NOT NULL DEFAULT (unixepoch()),
      closed_at INTEGER,
      pnl_sol REAL
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL REFERENCES positions(id),
      reason TEXT NOT NULL,
      details TEXT,
      triggered_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Persisted price history for exit-strategy / panic-detector.
    -- Это даёт recovery после рестарта: BB/RSI/ATH не «забываются».
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL REFERENCES positions(id),
      ts INTEGER NOT NULL DEFAULT (unixepoch()),
      price REAL NOT NULL
    );

    -- ATH-трекер для re-notification по новому хаю (Фаза 3 будет писать сюда
    -- last_notified_*; таблицу создаём сейчас, чтобы не трогать схему дважды).
    CREATE TABLE IF NOT EXISTS token_ath (
      address TEXT PRIMARY KEY,
      ath REAL NOT NULL DEFAULT 0,
      ath_at INTEGER,
      last_notified_ath REAL NOT NULL DEFAULT 0,
      last_notified_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_watched_status ON watched_tokens(status);
    CREATE INDEX IF NOT EXISTS idx_tokens_discovered ON tokens(discovered_at);
    CREATE INDEX IF NOT EXISTS idx_price_history_pos_ts ON price_history(position_id, ts);
  `);
}
