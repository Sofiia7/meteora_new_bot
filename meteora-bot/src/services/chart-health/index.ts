import { RSI } from 'technicalindicators';
import { config } from '../../shared/config';
import { TokenAthRepo } from '../../shared/repositories';
import { TokenInfo } from '../../shared/types';
import { GeckoTerminal } from '../geckoterminal';

/**
 * Chart-health analyzer.
 *
 * Возвращает score 0-100. Пороги: MIN_HEALTH_SCORE (по умолч. 65),
 * MAX_ATH_DISTANCE_PCT (30).
 *
 * ATH/RSI берём из **реальных 15м-свечей GeckoTerminal** (по лучшей паре токена):
 *  - ATH = max(high) за окно свечей, скомбинированный с rolling-ATH из token_ath
 *    (который копится между запусками) → честная просадка от хая, а не «с момента старта бота»;
 *  - RSI(14) на 15м-close — честный 15-минутный RSI.
 * Если свечей нет (совсем свежий токен / пары нет на Gecko) — мягко падаем на
 * rolling-ATH и пропускаем RSI.
 */

export interface ChartHealth {
  score: number; // 0-100
  isNearAth: boolean;
  athDistancePct: number; // % просадки от ATH (0 = на ATH)
  volumeScore: number; // 0-100
  rsi: number | null; // 15м RSI(14), null если мало данных
  reasons: string[];
  passes: boolean;
}

export class ChartHealthAnalyzer {
  private gecko = new GeckoTerminal();

  async analyze(token: TokenInfo): Promise<ChartHealth> {
    // 1. Реальные 15м-свечи по лучшей паре токена → ATH (max high) + RSI(14).
    let candleAth = 0;
    let rsi: number | null = null;
    if (token.pairAddress) {
      const candles = await this.gecko.ohlcv15m(token.pairAddress, 100);
      if (candles.length > 0) {
        candleAth = candles.reduce((m, c) => (c.high > m ? c.high : m), 0);
        if (candles.length >= 15) {
          const out = RSI.calculate({ period: 14, values: candles.map((c) => c.close) });
          rsi = out.length ? out[out.length - 1] : null;
        }
      }
    }

    // ATH копим в token_ath (переживает рестарты), комбинируем со свечным ATH.
    TokenAthRepo.updateIfHigher(token.address, Math.max(token.priceUsd, candleAth));
    const athRow = TokenAthRepo.get(token.address);
    const ath = Math.max(token.ath, athRow?.ath ?? 0, candleAth, token.priceUsd);

    const reasons: string[] = [];
    let score = 100;

    // 2. ATH distance — основной фильтр.
    const athDistancePct = ath > 0 ? ((ath - token.priceUsd) / ath) * 100 : 0;
    const maxAth = config.chartHealth.maxAthDistancePct;
    if (athDistancePct > maxAth) {
      const athPenalty = Math.min(60, ((athDistancePct - maxAth) / 5) * 10);
      reasons.push(`Цена -${athDistancePct.toFixed(1)}% от ATH (порог ${maxAth}%)`);
      score -= athPenalty;
    }

    // 3. Volume — выше порога = хорошо.
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

    // 4. Liquidity vs market cap — слишком тонкая ликвидность опасна.
    if (token.marketCap > 0 && token.liquidity > 0) {
      const liqRatio = token.liquidity / token.marketCap;
      if (liqRatio < 0.02) {
        reasons.push(`Слабая ликвидность: ${(liqRatio * 100).toFixed(2)}% от MCap`);
        score -= 10;
      }
    }

    // 5. priceChange24h — экстремальные дампы сигналят дамп-фазу.
    if (token.priceChange24h < -50) {
      reasons.push(`Дамп 24h: ${token.priceChange24h.toFixed(1)}%`);
      score -= 25;
    } else if (token.priceChange24h < -25) {
      reasons.push(`Просадка 24h: ${token.priceChange24h.toFixed(1)}%`);
      score -= 10;
    }

    // 6. RSI(15м) — перегрев: входить в LP на верхушке невыгодно.
    if (rsi !== null && rsi > 75) {
      reasons.push(`Перегрет: RSI(15м) ${rsi.toFixed(0)}`);
      score -= 8;
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const isNearAth = athDistancePct <= maxAth;
    const passes = score >= config.chartHealth.minScore && athDistancePct < 90;

    return { score, isNearAth, athDistancePct, volumeScore, rsi, reasons, passes };
  }
}
