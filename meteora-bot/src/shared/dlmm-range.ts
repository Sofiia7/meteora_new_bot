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
 * Диапазон бинов для однонаправленного (только SOL) депозита — см. комментарий
 * в lp-manager.openPosition для обоснования направления (SOL=Y → выше active,
 * SOL=X → ниже active).
 */
export function computeSingleSidedBinRange(input: SingleSidedRangeInput): SingleSidedRange {
  const upperPriceMultiplier = 1 + input.priceRangeUpperPct / 100;

  if (input.yIsSol) {
    const minBinId = input.activeBinId + 1;
    const upperBinId = binIdFromRawPrice(
      input.rawActivePrice * upperPriceMultiplier,
      input.binStep,
      false
    );
    return { minBinId, maxBinId: Math.max(upperBinId, minBinId) };
  }

  const lowerPriceMultiplier = 1 / upperPriceMultiplier;
  const maxBinId = input.activeBinId - 1;
  const lowerBinId = binIdFromRawPrice(
    input.rawActivePrice * lowerPriceMultiplier,
    input.binStep,
    true
  );
  return { minBinId: Math.min(lowerBinId, maxBinId), maxBinId };
}
