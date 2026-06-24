import { describe, it, expect } from 'vitest';
import { isNewAth, isFeeTarget, bollingerUpper } from '../src/services/exit-strategy/signals';

describe('isNewAth', () => {
  it('срабатывает при пробое прошлого ATH более чем на 5%', () => {
    expect(isNewAth(1.06, 1.0, 10)).toBe(true);
  });
  it('не срабатывает при пробое меньше 5%', () => {
    expect(isNewAth(1.04, 1.0, 10)).toBe(false);
  });
  it('не срабатывает на старте позиции (мало истории)', () => {
    expect(isNewAth(2.0, 1.0, 3)).toBe(false);
  });
  it('не срабатывает без референсного ATH', () => {
    expect(isNewAth(2.0, 0, 10)).toBe(false);
  });
});

describe('isFeeTarget', () => {
  it('срабатывает на пороге и выше', () => {
    expect(isFeeTarget(0.05, 0.05)).toBe(true);
    expect(isFeeTarget(0.06, 0.05)).toBe(true);
  });
  it('не срабатывает ниже порога', () => {
    expect(isFeeTarget(0.04, 0.05)).toBe(false);
  });
});

describe('bollingerUpper', () => {
  it('возвращает null, если данных меньше периода', () => {
    expect(bollingerUpper([1, 2, 3], 20, 2)).toBeNull();
  });

  it('возвращает число при достаточной истории', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 2);
    const upper = bollingerUpper(prices, 20, 2);
    expect(upper).not.toBeNull();
    expect(typeof upper).toBe('number');
  });

  it('ценовой шип уходит выше верхней полосы (пробой)', () => {
    // 25 стабильных точек + резкий шип вверх.
    const prices = [...Array.from({ length: 25 }, () => 100), 130];
    const upper = bollingerUpper(prices, 20, 2);
    expect(upper).not.toBeNull();
    expect(130).toBeGreaterThan(upper as number);
  });
});
