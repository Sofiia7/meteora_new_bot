/**
 * Чистая реализация DLMM.getBinIdFromPrice (та же формула, что в SDK:
 * binId = log(price) / log(1 + binStep/10000)) — вынесена, чтобы юнит-тестить
 * без живого пула. КРИТИЧНО: price здесь — RAW (per-lamport) цена, та же,
 * что в activeBin.price, а НЕ decimal-adjusted цена из fromPricePerLamport().
 * Смешивание этих двух доменов и было багом: raw и UI-цена отличаются на
 * 10^(decimalsY-decimalsX), из-за чего диапазон схлопывался в один бин.
 */
export function binIdFromRawPrice(rawPrice: number, binStep: number, roundDown: boolean): number {
  const binStepFraction = binStep / 10000;
  const binId = Math.log(rawPrice) / Math.log(1 + binStepFraction);
  return roundDown ? Math.floor(binId) : Math.ceil(binId);
}

export interface SingleSidedRangeInput {
  activeBinId: number;
  /** RAW (per-lamport) цена активного бина — Number(activeBin.price), не UI-цена. */
  rawActivePrice: number;
  binStep: number;
  yIsSol: boolean;
  priceRangeUpperPct: number;
}

export interface SingleSidedRange {
  minBinId: number;
  maxBinId: number;
}

/**
 * Диапазон бинов для однонаправленного (только SOL) депозита.
 *
 * Направление определяется НЕ бизнес-логикой роста цены, а SDK: в
 * @meteora-ag/dlmm (dist/index.js, toAmountBothSide) выбор bid/ask-стороны
 * зависит только от положения диапазона относительно activeId, а не от
 * strategyType (Spot/BidAsk/Curve) — это баг, который мы ловили две сессии
 * подряд, меняя не то (price-domain, потом Spot→BidAsk), пока не прочитали
 * сам SDK:
 *   - диапазон ЦЕЛИКОМ ВЫШЕ activeId → toAmountAskSide → использует ТОЛЬКО
 *     totalXAmount, totalYAmount молча игнорируется (уходит в 0 у всех бинов).
 *   - диапазон ЦЕЛИКОМ НИЖЕ activeId → toAmountBidSide → использует ТОЛЬКО
 *     totalYAmount, totalXAmount молча игнорируется.
 * Поэтому депозит чистым Y (SOL=Y) обязан лежать НИЖЕ active, а депозит
 * чистым X (SOL=X) — ВЫШЕ active. Раньше было ровно наоборот, отсюда
 * totalXAmount/totalYAmount = 0 на реальных tx независимо от strategyType.
 */
export function computeSingleSidedBinRange(input: SingleSidedRangeInput): SingleSidedRange {
  const rangeMultiplier = 1 + input.priceRangeUpperPct / 100;

  if (input.yIsSol) {
    const maxBinId = input.activeBinId - 1;
    const lowerBinId = binIdFromRawPrice(
      input.rawActivePrice / rangeMultiplier,
      input.binStep,
      true
    );
    return { minBinId: Math.min(lowerBinId, maxBinId), maxBinId };
  }

  const minBinId = input.activeBinId + 1;
  const upperBinId = binIdFromRawPrice(
    input.rawActivePrice * rangeMultiplier,
    input.binStep,
    false
  );
  return { minBinId, maxBinId: Math.max(upperBinId, minBinId) };
}
