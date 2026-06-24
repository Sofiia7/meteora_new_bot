import { BollingerBands } from 'technicalindicators';

/**
 * Чистые функции тейк-профит-сигналов — вынесены из ExitStrategy ради тестов.
 * Никакого I/O: получают числа/массивы, возвращают решение.
 */

/**
 * Новый ATH: цена пробила прошлый сигнальный ATH более чем на 5%.
 * Требуем минимум истории (>5 точек), чтобы не сработать на старте позиции.
 */
export function isNewAth(currentPrice: number, referenceAth: number, sampleCount: number): boolean {
  return sampleCount > 5 && referenceAth > 0 && currentPrice > referenceAth * 1.05;
}

/** Цель по комиссиям достигнута (доля unclaimed-fees от позиции ≥ порога). */
export function isFeeTarget(feeRatio: number, threshold: number): boolean {
  return feeRatio >= threshold;
}

/**
 * Верхняя полоса Bollinger по последней точке серии, либо null если данных мало.
 * ExitStrategy сравнивает текущую цену с этим значением (пробой вверх = тейк-профит).
 */
export function bollingerUpper(
  prices: number[],
  period: number,
  stdDev: number
): number | null {
  const bb = BollingerBands.calculate({ period, stdDev, values: prices });
  if (bb.length === 0) return null;
  return bb[bb.length - 1].upper;
}
