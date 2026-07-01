import { describe, it, expect } from 'vitest';
import { passesScannerFilters } from '../src/services/scanner';
import { TokenInfo } from '../src/shared/types';

// setup.ts фиксирует MIN_MARKET_CAP=250000, MIN_VOLUME_24H=1000000.
function token(over: Partial<TokenInfo> = {}): TokenInfo {
  return {
    address: 'addr',
    symbol: 'TKN',
    name: 'Token',
    marketCap: 500_000,
    volume24h: 2_000_000,
    priceUsd: 1,
    priceChange24h: 0,
    ath: 0,
    athDate: '',
    liquidity: 50_000,
    pairAddress: 'pair',
    dexId: 'meteora',
    chainId: 'solana',
    createdAt: 0,
    ...over,
  };
}

describe('passesScannerFilters', () => {
  it('пропускает токен выше порогов на solana', () => {
    expect(passesScannerFilters(token())).toBe(true);
  });

  it('режет по низкому market cap', () => {
    expect(passesScannerFilters(token({ marketCap: 100_000 }))).toBe(false);
  });

  it('режет по низкому объёму 24h', () => {
    expect(passesScannerFilters(token({ volume24h: 500_000 }))).toBe(false);
  });

  it('режет не-solana сети', () => {
    expect(passesScannerFilters(token({ chainId: 'ethereum' }))).toBe(false);
  });

  it('граничные значения (ровно на пороге) проходят', () => {
    expect(passesScannerFilters(token({ marketCap: 250_000, volume24h: 1_000_000 }))).toBe(true);
  });

  // setup.ts фиксирует MAX_TOKEN_AGE_DAYS=21.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = 1_800_000_000_000;

  it('режет токены старше порога возраста (SOL/JUP/старые blue-chip пары)', () => {
    const old = token({ createdAt: NOW - 30 * DAY_MS });
    expect(passesScannerFilters(old, NOW)).toBe(false);
  });

  it('пропускает токены младше порога возраста', () => {
    const fresh = token({ createdAt: NOW - 10 * DAY_MS });
    expect(passesScannerFilters(fresh, NOW)).toBe(true);
  });

  it('пропускает, если возраст неизвестен (createdAt=0)', () => {
    expect(passesScannerFilters(token({ createdAt: 0 }), NOW)).toBe(true);
  });
});
