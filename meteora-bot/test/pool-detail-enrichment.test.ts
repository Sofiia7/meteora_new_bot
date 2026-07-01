import { describe, it, expect } from 'vitest';
import { mapMeteoraPoolDetail } from '../src/services/pool-watcher';

describe('mapMeteoraPoolDetail', () => {
  it('переводит base_fee_pct в feeBps и достаёт bin_step/tvl', () => {
    const result = mapMeteoraPoolDetail({
      pool_config: { bin_step: 20, base_fee_pct: 0.2 },
      tvl: 154680,
    });
    expect(result).toEqual({ feeBps: 20, binStep: 20, tvl: 154680 });
  });

  it('5% base_fee_pct -> 500 feeBps (совпадает с targetFeeBps стратегии)', () => {
    const result = mapMeteoraPoolDetail({
      pool_config: { bin_step: 100, base_fee_pct: 5 },
      tvl: 1000,
    });
    expect(result!.feeBps).toBe(500);
  });

  it('возвращает null, если нет pool_config', () => {
    expect(mapMeteoraPoolDetail({ tvl: 100 })).toBeNull();
  });

  it('возвращает null для null/undefined', () => {
    expect(mapMeteoraPoolDetail(null)).toBeNull();
    expect(mapMeteoraPoolDetail(undefined)).toBeNull();
  });

  it('tvl по умолчанию 0, если не передан', () => {
    const result = mapMeteoraPoolDetail({
      pool_config: { bin_step: 10, base_fee_pct: 0.1 },
    });
    expect(result!.tvl).toBe(0);
  });
});
