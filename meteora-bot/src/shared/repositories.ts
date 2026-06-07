import { getDb } from './db';
import { Position, PositionStatus, WatchedToken } from './types';

/**
 * Repository-слой. Единственное место, где мы маппим snake_case колонки SQLite
 * в camelCase Position/WatchedToken. Бизнес-код не должен делать SELECT * напрямую
 * — это приводило к undefined полям (#1 в аудите).
 */

const POSITION_COLUMNS = `
  id,
  token_address     AS tokenAddress,
  token_symbol      AS tokenSymbol,
  pool_address      AS poolAddress,
  fee_bps           AS feeBps,
  bin_step          AS binStep,
  entry_price       AS entryPrice,
  sol_amount        AS solAmount,
  position_pubkey   AS positionPubkey,
  status,
  opened_at         AS openedAt,
  closed_at         AS closedAt,
  pnl_sol           AS pnlSol
`;

const WATCHED_COLUMNS = `
  id,
  token_address     AS tokenAddress,
  token_symbol      AS tokenSymbol,
  started_at        AS startedAt,
  status
`;

export const Positions = {
  findActive(): Position[] {
    return getDb()
      .prepare(`SELECT ${POSITION_COLUMNS} FROM positions WHERE status='active'`)
      .all() as Position[];
  },

  /** Активные + те, что мы только что начали закрывать. Для exit-monitor’а. */
  findOpen(): Position[] {
    return getDb()
      .prepare(
        `SELECT ${POSITION_COLUMNS} FROM positions WHERE status IN ('active','closing')`
      )
      .all() as Position[];
  },

  findById(id: number): Position | null {
    const row = getDb()
      .prepare(`SELECT ${POSITION_COLUMNS} FROM positions WHERE id=?`)
      .get(id) as Position | undefined;
    return row ?? null;
  },

  /** Только если статус действительно 'active' (защита от двойного закрытия). */
  findActiveById(id: number): Position | null {
    const row = getDb()
      .prepare(`SELECT ${POSITION_COLUMNS} FROM positions WHERE id=? AND status='active'`)
      .get(id) as Position | undefined;
    return row ?? null;
  },

  countActive(): number {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS cnt FROM positions WHERE status='active'`)
      .get() as { cnt: number };
    return row.cnt;
  },

  /**
   * Атомарный переход active → closing. Возвращает true, если переход
   * выполнен этим вызовом; false — позиция уже была не-active. Это даёт
   * идемпотентность exit: только один воркер реально запустит закрытие.
   */
  markClosing(id: number): boolean {
    const res = getDb()
      .prepare(`UPDATE positions SET status='closing' WHERE id=? AND status='active'`)
      .run(id);
    return res.changes > 0;
  },

  markClosed(id: number, pnlSol: number | null): void {
    getDb()
      .prepare(
        `UPDATE positions SET status='closed', closed_at=unixepoch(), pnl_sol=? WHERE id=?`
      )
      .run(pnlSol, id);
  },

  /** Откат closing → active, если решили не закрывать (напр. on-chain позиции уже нет). */
  markActiveAgain(id: number): void {
    getDb()
      .prepare(`UPDATE positions SET status='active' WHERE id=? AND status='closing'`)
      .run(id);
  },

  insert(input: {
    tokenAddress: string;
    tokenSymbol: string;
    poolAddress: string;
    feeBps: number;
    binStep: number;
    entryPrice: number;
    solAmount: number;
    positionPubkey: string;
    status?: PositionStatus;
  }): number {
    const res = getDb()
      .prepare(
        `INSERT INTO positions
           (token_address, token_symbol, pool_address, fee_bps, bin_step,
            entry_price, sol_amount, position_pubkey, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.tokenAddress,
        input.tokenSymbol,
        input.poolAddress,
        input.feeBps,
        input.binStep,
        input.entryPrice,
        input.solAmount,
        input.positionPubkey,
        input.status ?? 'active'
      );
    return Number(res.lastInsertRowid);
  },
};

export const WatchedTokens = {
  findWatching(): WatchedToken[] {
    return getDb()
      .prepare(`SELECT ${WATCHED_COLUMNS} FROM watched_tokens WHERE status='watching'`)
      .all() as WatchedToken[];
  },

  countWatching(): number {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS cnt FROM watched_tokens WHERE status='watching'`)
      .get() as { cnt: number };
    return row.cnt;
  },

  latestSymbol(tokenAddress: string): string | null {
    const row = getDb()
      .prepare(
        `SELECT token_symbol AS tokenSymbol FROM watched_tokens
         WHERE token_address=? ORDER BY id DESC LIMIT 1`
      )
      .get(tokenAddress) as { tokenSymbol: string } | undefined;
    return row?.tokenSymbol ?? null;
  },

  insertWatching(tokenAddress: string, tokenSymbol: string): void {
    getDb()
      .prepare(
        `INSERT INTO watched_tokens (token_address, token_symbol, status) VALUES (?, ?, 'watching')`
      )
      .run(tokenAddress, tokenSymbol);
  },

  setStatus(
    tokenAddress: string,
    fromStatus: WatchedToken['status'],
    toStatus: WatchedToken['status']
  ): void {
    getDb()
      .prepare(`UPDATE watched_tokens SET status=? WHERE token_address=? AND status=?`)
      .run(toStatus, tokenAddress, fromStatus);
  },
};

export const Tokens = {
  upsert(t: {
    address: string;
    symbol: string;
    name: string;
    marketCap: number;
    volume24h: number;
    priceUsd: number;
    ath: number;
  }): void {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO tokens
           (address, symbol, name, market_cap, volume_24h, price_usd, ath)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(t.address, t.symbol, t.name, t.marketCap, t.volume24h, t.priceUsd, t.ath);
  },

  setSecurity(address: string, passed: boolean, warnings: string[]): void {
    getDb()
      .prepare(`UPDATE tokens SET security_passed=?, security_warnings=? WHERE address=?`)
      .run(passed ? 1 : 0, JSON.stringify(warnings), address);
  },

  /**
   * Замена in-memory `seenTokens` Scanner'а: персистентно проверяем,
   * видели ли мы этот адрес недавно. По умолчанию окно — 24 часа,
   * чтобы новая «жизнь» токена через сутки могла проявиться повторно
   * (полезно для re-notification по новому ATH в Фазе 3).
   */
  seenWithin(address: string, windowSec: number): boolean {
    const row = getDb()
      .prepare(
        `SELECT 1 FROM tokens
         WHERE address=? AND discovered_at >= unixepoch() - ?`
      )
      .get(address, windowSec) as { 1: number } | undefined;
    return !!row;
  },
};

export const PriceHistoryRepo = {
  insert(positionId: number, price: number): void {
    getDb()
      .prepare(`INSERT INTO price_history (position_id, price) VALUES (?, ?)`)
      .run(positionId, price);
  },

  /** Возвращает последние N цен в хронологическом порядке (старые → новые). */
  latestN(positionId: number, n: number): number[] {
    const rows = getDb()
      .prepare(
        `SELECT price FROM (
           SELECT id, price FROM price_history
           WHERE position_id=? ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`
      )
      .all(positionId, n) as { price: number }[];
    return rows.map((r) => r.price);
  },

  /** Чистим, чтобы price_history не разрасталась бесконечно. */
  pruneOlder(positionId: number, keepLast: number): void {
    getDb()
      .prepare(
        `DELETE FROM price_history
         WHERE position_id=? AND id NOT IN (
           SELECT id FROM price_history WHERE position_id=? ORDER BY id DESC LIMIT ?
         )`
      )
      .run(positionId, positionId, keepLast);
  },

  deleteByPosition(positionId: number): void {
    getDb()
      .prepare(`DELETE FROM price_history WHERE position_id=?`)
      .run(positionId);
  },
};

export interface TokenAthRow {
  address: string;
  ath: number;
  athAt: number | null;
  lastNotifiedAth: number;
  lastNotifiedAt: number | null;
}

export const TokenAthRepo = {
  get(address: string): TokenAthRow | null {
    const row = getDb()
      .prepare(
        `SELECT address,
                ath,
                ath_at            AS athAt,
                last_notified_ath AS lastNotifiedAth,
                last_notified_at  AS lastNotifiedAt
         FROM token_ath WHERE address=?`
      )
      .get(address) as TokenAthRow | undefined;
    return row ?? null;
  },

  /** Обновляем ATH если новый выше. Возвращает true, если ATH вырос. */
  updateIfHigher(address: string, price: number): boolean {
    if (price <= 0) return false;
    const res = getDb()
      .prepare(
        `INSERT INTO token_ath (address, ath, ath_at) VALUES (?, ?, unixepoch())
         ON CONFLICT(address) DO UPDATE SET
           ath = excluded.ath, ath_at = excluded.ath_at
         WHERE excluded.ath > token_ath.ath`
      )
      .run(address, price);
    return res.changes > 0;
  },

  markNotified(address: string, price: number): void {
    getDb()
      .prepare(
        `INSERT INTO token_ath (address, ath, ath_at, last_notified_ath, last_notified_at)
         VALUES (?, ?, unixepoch(), ?, unixepoch())
         ON CONFLICT(address) DO UPDATE SET
           last_notified_ath = excluded.last_notified_ath,
           last_notified_at  = excluded.last_notified_at`
      )
      .run(address, price, price);
  },
};

export function recordSignal(positionId: number, reason: string, details: string): void {
  getDb()
    .prepare(`INSERT INTO signals (position_id, reason, details) VALUES (?, ?, ?)`)
    .run(positionId, reason, details);
}
