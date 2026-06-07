import { config } from '../../shared/config';
import { TokenAthRepo } from '../../shared/repositories';
import { TokenInfo } from '../../shared/types';

/**
 * Chart-health analyzer (ТЗ 1.2).
 *
 * Возвращает score 0-100. Пороги: MIN_HEALTH_SCORE (по умолч. 65),
 * MAX_ATH_DISTANCE_PCT (30). Точный 15-минутный RSI требует OHLCV-провайдера
 * (Birdeye/GeckoTerminal с API-ключом); в MVP-версии оцениваем по тому, что
 * есть в DexScreener pair + наш собственный rolling-ATH из token_ath.
 *
 * Главное — отсечь явных «мертвецов» и ракеты, ушедшие слишком далеко от ATH.
 */

export interface ChartHealth {
  score: number;            // 0-100
  isNearAth: boolean;       // цена ≥ (100 - MAX_ATH_DISTANCE_PCT)% от ATH
  athDistancePct: number;   // % просадки от ATH (0 = на ATH)
  volumeScore: number;      // 0-100
  reasons: string[];        // понятные причины снижения score (для TG)
  passes: boolean;          // score >= MIN_HEALTH_SCORE и не явный труп
}

export class ChartHealthAnalyzer {
  /**
   * При первом анализе нового токена обновляем его ATH-record на текущей цене
   * (это даст «нулевой» athDistance, поэтому первое прохождение почти всегда ок).
   * При повторных анализах (re-notify) athDistance уже реален и фильтр работает.
   */
  analyze(token: TokenInfo): ChartHealth {
    // Сначала обновляем БД, чтобы ATH «копился» от запуска к запуску.
    TokenAthRepo.updateIfHigher(token.address, token.priceUsd);
    const athRow = TokenAthRepo.get(token.address);
    const ath = Math.max(token.ath, athRow?.ath ?? 0, token.priceUsd);

    const reasons: string[] = [];
    let score = 100;

    // 1. ATH distance — основной фильтр (ТЗ 1.2).
    const athDistancePct = ath > 0 ? ((ath - token.priceUsd) / ath) * 100 : 0;
    const maxAth = config.chartHealth.maxAthDistancePct;
    let athPenalty = 0;
    if (athDistancePct > maxAth) {
      // Чем дальше от ATH, тем больше штраф; за каждые 5% сверх лимита — −10.
      athPenalty = Math.min(60, ((athDistancePct - maxAth) / 5) * 10);
      reasons.push(`Цена -${athDistancePct.toFixed(1)}% от ATH (порог ${maxAth}%)`);
    }
    score -= athPenalty;

    // 2. Volume — выше порога = хорошо, на пороге = средне, ниже = плохо.
    const volTarget = config.scanner.minVolume24h;
    const volRatio = volTarget > 0 ? token.volume24h / volTarget : 0;
    let volumeScore = 0;
    if (volRatio >= 3) volumeScore = 100;
    else if (volRatio >= 1.5) volumeScore = 85;
    else if (volRatio >= 1) volumeScore = 70;
    else if (volRatio >= 0.5) volumeScore = 40;
    else volumeScore = 10;
    if (volumeScore < 50) {
      reasons.push(`Низкий объём 24h: $${token.volume24h.toFixed(0)}`);
      score -= (50 - volumeScore) * 0.4;
    }

    // 3. Liquidity vs market cap — слишком тонкая ликвидность опасна.
    if (token.marketCap > 0 && token.liquidity > 0) {
      const liqRatio = token.liquidity / token.marketCap;
      if (liqRatio < 0.02) {
        reasons.push(`Слабая ликвидность: ${(liqRatio * 100).toFixed(2)}% от MCap`);
        score -= 10;
      }
    }

    // 4. priceChange24h — экстремальные дампы сигналят дамп-фазу.
    if (token.priceChange24h < -50) {
      reasons.push(`Дамп 24h: ${token.priceChange24h.toFixed(1)}%`);
      score -= 25;
    } else if (token.priceChange24h < -25) {
      reasons.push(`Просадка 24h: ${token.priceChange24h.toFixed(1)}%`);
      score -= 10;
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const isNearAth = athDistancePct <= maxAth;
    const passes = score >= config.chartHealth.minScore && athDistancePct < 90;

    return { score, isNearAth, athDistancePct, volumeScore, reasons, passes };
  }
}
