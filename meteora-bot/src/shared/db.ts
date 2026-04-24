import Database from 'better-sqlite3';
import path from 'path';
import { logger } from './logger';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(path.resolve(process.cwd(), 'data/bot.db'));
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

    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_watched_status ON watched_tokens(status);
  `);
}
