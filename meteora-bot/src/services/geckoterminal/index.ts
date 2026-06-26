import { geckoQ } from '../../shared/http-queue';
import { logger } from '../../shared/logger';

/**
 * GeckoTerminal — бесплатный (без ключа) источник. Используется вместо
 * заблокированного на VPS GMGN (403 Cloudflare):
 *  - соцсети токена (twitter/website) → сигнал `twitterActive` в security;
 *  - `gt_score` (0–100, выше = больше доверия) → траст-фактор в security;
 *  - OHLCV-свечи (15м) → реальный ATH/RSI (chart-health), вместо скользящего максимума.
 *
 * Все имена полей сверены с живыми ответами API (token `/info`, pool `/ohlcv`).
 */

const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const HEADERS = { Accept: 'application/json' };

export interface GeckoMeta {
  available: boolean;
  twitterActive: boolean;
  /** gt_score 0–100, выше = больше доверия. null если неизвестно. */
  gtScore: number | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class GeckoTerminal {
  /** Метаданные токена: соцсети + gt_score. */
  async tokenMeta(tokenAddress: string): Promise<GeckoMeta> {
    try {
      const resp = await geckoQ.get(
        `${GECKO_API}/networks/solana/tokens/${tokenAddress}/info`,
        { timeout: 10000, headers: HEADERS }
      );
      const a = resp.data?.data?.attributes ?? {};
      const twitter: string | null = a.twitter_handle ?? null;
      const websites: string[] = Array.isArray(a.websites) ? a.websites : [];
      return {
        available: true,
        twitterActive: !!twitter,
        gtScore: typeof a.gt_score === 'number' ? a.gt_score : null,
        twitterUrl: twitter ? `https://twitter.com/${twitter}` : null,
        websiteUrl: websites[0] ?? null,
      };
    } catch (err) {
      logger.warn(`GeckoTerminal info failed for ${tokenAddress}: ${err}`);
      return { available: false, twitterActive: false, gtScore: null, twitterUrl: null, websiteUrl: null };
    }
  }

  /**
   * 15-минутные OHLCV-свечи по адресу пула (для реального ATH/RSI).
   * Возвращает от старых к новым; пустой массив при ошибке.
   */
  async ohlcv15m(poolAddress: string, limit = 100): Promise<Candle[]> {
    try {
      const resp = await geckoQ.get(
        `${GECKO_API}/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=15&limit=${limit}`,
        { timeout: 10000, headers: HEADERS }
      );
      const list: number[][] = resp.data?.data?.attributes?.ohlcv_list ?? [];
      // API отдаёт новые→старые; переворачиваем в хронологический порядок.
      return list
        .map((c) => ({ ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
        .reverse();
    } catch (err) {
      logger.warn(`GeckoTerminal OHLCV failed for ${poolAddress}: ${err}`);
      return [];
    }
  }
}
