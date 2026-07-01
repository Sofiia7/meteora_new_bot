import { describe, it, expect } from 'vitest';
import { mapMeteoraPoolToTokenInfo, MeteoraDlmmPool } from '../src/services/scanner';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function tokenSide(over: Partial<MeteoraDlmmPool['token_x']> = {}): MeteoraDlmmPool['token_x'] {
  return {
    address: 'mint',
    name: 'Some Token',
    symbol: 'TKN',
    decimals: 6,
    is_verified: true,
    holders: 100,
    freeze_authority_disabled: true,
    total_supply: 1_000_000,
    price: 1,
    market_cap: 1_000_000,
    ...over,
  };
}

function pool(over: Partial<MeteoraDlmmPool> = {}): MeteoraDlmmPool {
  return {
    address: 'poolAddr',
    name: 'TKN-SOL',
    token_x: tokenSide(),
    token_y: tokenSide({ address: SOL, symbol: 'SOL', name: 'Wrapped SOL', market_cap: 1e11 }),
    created_at: 1700000000000,
    pool_config: { bin_step: 20, base_fee_pct: 0.2 },
    tvl: 500_000,
    volume: { '30m': 0, '1h': 0, '2h': 0, '4h': 0, '12h': 0, '24h': 2_000_000 },
    is_blacklisted: false,
    ...over,
  };
}

describe('mapMeteoraPoolToTokenInfo', () => {
  it('выбирает не-мажорную сторону как токен (token_x = мем, token_y = SOL)', () => {
    const info = mapMeteoraPoolToTokenInfo(pool());
    expect(info).not.toBeNull();
    expect(info!.address).toBe('mint');
    expect(info!.symbol).toBe('TKN');
    expect(info!.marketCap).toBe(1_000_000);
    expect(info!.volume24h).toBe(2_000_000);
    expect(info!.liquidity).toBe(500_000);
    expect(info!.pairAddress).toBe('poolAddr');
    expect(info!.dexId).toBe('meteora');
    expect(info!.chainId).toBe('solana');
    expect(info!.createdAt).toBe(1700000000000);
  });

  it('выбирает token_y, если мем-токен на стороне Y, а мажор на X', () => {
    const p = pool({
      token_x: tokenSide({ address: USDC, symbol: 'USDC', name: 'USD Coin', market_cap: 8e9 }),
      token_y: tokenSide({ address: 'mint2', symbol: 'MEME', name: 'Meme' }),
    });
    const info = mapMeteoraPoolToTokenInfo(p);
    expect(info).not.toBeNull();
    expect(info!.address).toBe('mint2');
    expect(info!.symbol).toBe('MEME');
  });

  it('возвращает null, если обе стороны — мажорные токены (SOL-USDC)', () => {
    const p = pool({
      token_x: tokenSide({ address: SOL, symbol: 'SOL' }),
      token_y: tokenSide({ address: USDC, symbol: 'USDC' }),
    });
    expect(mapMeteoraPoolToTokenInfo(p)).toBeNull();
  });

  it('возвращает null для пулов в блэклисте', () => {
    expect(mapMeteoraPoolToTokenInfo(pool({ is_blacklisted: true }))).toBeNull();
  });
});
