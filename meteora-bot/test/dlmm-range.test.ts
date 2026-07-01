import { describe, it, expect } from 'vitest';
import { binIdFromRawPrice, computeSingleSidedBinRange } from '../src/shared/dlmm-range';

describe('binIdFromRawPrice', () => {
  it('округляет вниз при roundDown=true', () => {
    // binStep=100 (1% за бин): price=(1.01)^70 ~ разное округление вверх/вниз
    const price = Math.pow(1.01, 70.4);
    expect(binIdFromRawPrice(price, 100, true)).toBe(70);
  });

  it('округляет вверх при roundDown=false', () => {
    const price = Math.pow(1.01, 70.4);
    expect(binIdFromRawPrice(price, 100, false)).toBe(71);
  });

  it('обратная функция к (1+binStep/10000)^binId — round-trip', () => {
    const binStep = 20;
    const binId = 500;
    const price = Math.pow(1 + binStep / 10000, binId);
    expect(binIdFromRawPrice(price, binStep, false)).toBe(binId);
  });
});

describe('computeSingleSidedBinRange', () => {
  // Реальные данные с пула world-SOL (bin_step=100), где раньше диапазон
  // схлопывался в 1 бин из-за бага (human-price вместо raw).
  const rawActivePrice = 0.09745374540555998;
  const activeBinId = -234;
  const binStep = 100;

  // @meteora-ag/dlmm's toAmountBothSide (dist/index.js) picks the deposit side
  // purely from range-vs-activeId position, ignoring strategyType: a range
  // ENTIRELY ABOVE active uses toAmountAskSide (token X only, totalYAmount
  // silently dropped); ENTIRELY BELOW active uses toAmountBidSide (token Y
  // only, totalXAmount dropped). So a Y-only (SOL=Y) deposit must sit AT/BELOW
  // active, and an X-only (SOL=X) deposit must sit AT/ABOVE active — the
  // opposite of what this function computed before, which is why every
  // single-sided open deposited 0 regardless of Spot vs BidAsk.
  it('SOL=Y: диапазон далеко ниже .. activeBinId-1 (bid side, не схлопывается в 1 бин)', () => {
    const range = computeSingleSidedBinRange({
      activeBinId,
      rawActivePrice,
      binStep,
      yIsSol: true,
      priceRangeUpperPct: 100,
    });
    expect(range.maxBinId).toBe(activeBinId - 1);
    expect(range.minBinId).toBeLessThan(range.maxBinId - 50); // ~70 бинов на -100% при binStep=100
  });

  it('SOL=X: диапазон activeBinId+1 .. далеко выше (ask side, не схлопывается в 1 бин)', () => {
    const range = computeSingleSidedBinRange({
      activeBinId,
      rawActivePrice,
      binStep,
      yIsSol: false,
      priceRangeUpperPct: 100,
    });
    expect(range.minBinId).toBe(activeBinId + 1);
    expect(range.maxBinId).toBeGreaterThan(range.minBinId + 50);
  });

  it('не даёт диапазону инвертироваться, если upperBinId вдруг <= minBinId', () => {
    // Экстремально маленький priceRangeUpperPct -> upperBinId может не дотянуть
    // даже до +1 бина; диапазон должен схлопнуться в 1 бин, а не инвертироваться.
    const range = computeSingleSidedBinRange({
      activeBinId,
      rawActivePrice,
      binStep,
      yIsSol: false,
      priceRangeUpperPct: 0.0001,
    });
    expect(range.maxBinId).toBeGreaterThanOrEqual(range.minBinId);
  });
});
