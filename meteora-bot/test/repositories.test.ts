import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

/**
 * Тесты mapper'а snake_case → camelCase на реальном SQLite (in-memory).
 *
 * better-sqlite3 — нативный аддон. На машине без собранного под текущий Node
 * бинаря (напр. свежий Node без prebuild) загрузить его нельзя — тогда DB-тесты
 * ПРОПУСКАЕМ, а не валим всю сборку. В CI (Node 20 с prebuild) модуль грузится и
 * тесты гоняются по-настоящему. Импорт repositories — динамический, чтобы файл не
 * падал на этапе импорта, если нативный модуль отсутствует.
 */
let dbAvailable = true;
try {
  const req = createRequire(import.meta.url);
  const Database = req('better-sqlite3');
  new Database(':memory:').close();
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('Positions mapper (snake_case → camelCase)', () => {
  it('insert → findById возвращает корректно смаппленные поля', async () => {
    const { Positions } = await import('../src/shared/repositories');
    const id = Positions.insert({
      tokenAddress: 'TokenAddr111',
      tokenSymbol: 'WIF',
      poolAddress: 'PoolAddr222',
      feeBps: 500,
      binStep: 100,
      entryPrice: 0.00001234,
      solAmount: 0.1,
      positionPubkey: 'PosPubkey333',
    });

    const p = Positions.findById(id);
    expect(p).not.toBeNull();
    expect(p?.tokenAddress).toBe('TokenAddr111');
    expect(p?.tokenSymbol).toBe('WIF');
    expect(p?.poolAddress).toBe('PoolAddr222');
    expect(p?.feeBps).toBe(500);
    expect(p?.binStep).toBe(100);
    expect(p?.entryPrice).toBeCloseTo(0.00001234);
    expect(p?.solAmount).toBeCloseTo(0.1);
    expect(p?.positionPubkey).toBe('PosPubkey333');
    expect(p?.status).toBe('active');
  });

  it('markClosing атомарен: второй вызов возвращает false (идемпотентность выхода)', async () => {
    const { Positions } = await import('../src/shared/repositories');
    const id = Positions.insert({
      tokenAddress: 'T',
      tokenSymbol: 'T',
      poolAddress: 'P',
      feeBps: 100,
      binStep: 80,
      entryPrice: 1,
      solAmount: 0.1,
      positionPubkey: 'PK',
    });
    expect(Positions.markClosing(id)).toBe(true);
    expect(Positions.markClosing(id)).toBe(false);
    expect(Positions.findActiveById(id)).toBeNull();
  });
});

describe.skipIf(!dbAvailable)('WatchedTokens mapper + watchlist', () => {
  it('insert → findWatching маппит token_address/token_symbol', async () => {
    const { WatchedTokens } = await import('../src/shared/repositories');
    WatchedTokens.insertWatching('WatchAddr', 'WATCH');
    const rows = WatchedTokens.findWatching();
    const row = rows.find((r) => r.tokenAddress === 'WatchAddr');
    expect(row).toBeDefined();
    expect(row?.tokenSymbol).toBe('WATCH');
    expect(row?.status).toBe('watching');
  });

  it('cancel() убирает токен из активного ватчлиста', async () => {
    const { WatchedTokens } = await import('../src/shared/repositories');
    WatchedTokens.insertWatching('ToCancel', 'CNL');
    WatchedTokens.cancel('ToCancel');
    const active = WatchedTokens.listActiveWatchlist();
    expect(active.find((r) => r.tokenAddress === 'ToCancel')).toBeUndefined();
  });
});
