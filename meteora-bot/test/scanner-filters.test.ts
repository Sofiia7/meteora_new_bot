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
});
