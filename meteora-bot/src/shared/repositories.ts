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
};

export function recordSignal(positionId: number, reason: string, details: string): void {
  getDb()
    .prepare(`INSERT INTO signals (position_id, reason, details) VALUES (?, ?, ?)`)
    .run(positionId, reason, details);
}
