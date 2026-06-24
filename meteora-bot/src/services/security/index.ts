import { gmgnQ, rugcheckQ, bubblemapsQ } from '../../shared/http-queue';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { cacheGet, cacheSet } from '../../shared/redis';
import { SecurityResult } from '../../shared/types';

const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';
const GMGN_API = 'https://gmgn.ai/defi/router/v1/sol/token_info';
const BUBBLEMAPS_API = 'https://api-legacy.bubblemaps.io/map-metadata';

/**
 * Веса скоринга (0–100). Откалибровано по живым ответам (Фаза 4, верифицировано):
 *  - GMGN на VPS отдаёт 403 (Cloudflare) → за его недоступность НЕ штрафуем,
 *    иначе любой токен валится не по своей вине.
 *  - RugCheck — основной риск-источник. `score_normalised` это РИСК (0=безопасно,
 *    100=максимальный риск), поэтому высокий = плохо.
 *  - BubbleMaps `/map-metadata` отдаёт `decentralisation_score` (0–100, выше=лучше),
 *    а НЕ список холдеров.
 * Hard-fail (honeypot / mint|freeze authority) перебивает скор.
 */
const PENALTY = {
  gmgnLowFees: 10,
  noTwitter: 5,
  rugcheckUnavailable: 30, // fail-closed: главный источник недоступен
  rugcheckRiskHigh: 30, // risk >= 60
  rugcheckRiskMed: 12, // risk 30..60
  rugcheckDanger: 25, // есть risk level=danger (помимо authority/honeypot)
  bubblemapsUnavailable: 15,
  lowDecentralisationHard: 25, // decentralisation < 15
  lowDecentralisationMed: 12, // decentralisation < 30
};

export interface GmgnData {
  available: boolean;
  totalFeesSol: number;
  hasTwitter: boolean;
}

export interface RugcheckData {
  available: boolean;
  /** score_normalised: 0 = безопасно … 100 = максимальный риск. */
  riskScore: number | null;
  hasDanger: boolean;
  honeypot: boolean;
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
}

export interface BubbleMapsData {
  available: boolean;
  /** decentralisation_score 0–100, выше = лучше. */
  decentralisationScore: number;
}

export class SecurityChecker {
  /**
   * Проверка безопасности токена. Score-based + fail-closed (Фаза 4).
   * @param opts.bypassCache — для периодического re-check активных позиций (panic F4).
   */
  async check(tokenAddress: string, opts?: { bypassCache?: boolean }): Promise<SecurityResult> {
    const cacheKey = `security:${tokenAddress}`;
    if (!opts?.bypassCache) {
      const cached = await cacheGet(cacheKey);
      if (cached) return JSON.parse(cached) as SecurityResult;
    }

    logger.info(`Security check for ${tokenAddress}${opts?.bypassCache ? ' (fresh)' : ''}`);

    const [gmgn, rugcheck, bubbleMaps] = await Promise.allSettled([
      this.checkGmgn(tokenAddress),
      this.checkRugcheck(tokenAddress),
      this.checkBubbleMaps(tokenAddress),
    ]);

    const result = evaluateSecurity(
      settled(gmgn, FALLBACK_GMGN),
      settled(rugcheck, FALLBACK_RUGCHECK),
      settled(bubbleMaps, FALLBACK_BUBBLEMAPS)
    );

    await cacheSet(cacheKey, JSON.stringify(result), 600);
    return result;
  }

  // ─── Источники (верифицировано против живых ответов) ──────────────────────────

  private async checkGmgn(tokenAddress: string): Promise<GmgnData> {
    try {
      const resp = await gmgnQ.get(`${GMGN_API}/${tokenAddress}`, { timeout: 8000 });
      const d = resp.data?.data ?? {};
      return {
        available: true,
        totalFeesSol: parseFloat(d.total_fees_sol ?? d.fee_sol ?? '0') || 0,
        hasTwitter: !!(d.twitter || d.social?.twitter || d.twitter_username),
      };
    } catch (err) {
      // На VPS обычно 403 Cloudflare — это ожидаемо, не вина токена.
      logger.warn(`GMGN unavailable for ${tokenAddress}: ${err}`);
      return { ...FALLBACK_GMGN };
    }
  }

  private async checkRugcheck(tokenAddress: string): Promise<RugcheckData> {
    try {
      const resp = await rugcheckQ.get(
        `${RUGCHECK_API}/tokens/${tokenAddress}/report/summary`,
        { timeout: 8000 }
      );
      const data = resp.data ?? {};
      const risks: Array<{ name?: string; level?: string }> = Array.isArray(data.risks)
        ? data.risks
        : [];
      const names = risks.map((r) => (r.name ?? '').toLowerCase());
      const has = (kw: string): boolean => names.some((n) => n.includes(kw));
      return {
        available: true,
        riskScore: typeof data.score_normalised === 'number' ? data.score_normalised : null,
        hasDanger: risks.some((r) => (r.level ?? '').toLowerCase() === 'danger'),
        honeypot: has('honeypot'),
        mintAuthorityActive: has('mint authority'),
        freezeAuthorityActive: has('freeze authority'),
      };
    } catch (err) {
      logger.warn(`RugCheck failed for ${tokenAddress}: ${err}`);
      return { ...FALLBACK_RUGCHECK };
    }
  }

  private async checkBubbleMaps(tokenAddress: string): Promise<BubbleMapsData> {
    try {
      const resp = await bubblemapsQ.get(
        `${BUBBLEMAPS_API}?token=${tokenAddress}&chain=sol`,
        { timeout: 8000 }
      );
      const d = resp.data ?? {};
      // Реальный ответ: { status:"OK", decentralisation_score:42.6, identified_supply:{...} }.
      if ((d.status ?? '').toString().toUpperCase() !== 'OK') return { ...FALLBACK_BUBBLEMAPS };
      const ds = typeof d.decentralisation_score === 'number' ? d.decentralisation_score : 0;
      return { available: true, decentralisationScore: ds };
    } catch (err) {
      logger.warn(`BubbleMaps failed for ${tokenAddress}: ${err}`);
      return { ...FALLBACK_BUBBLEMAPS };
    }
  }
}

/**
 * Чистая функция скоринга (без I/O) — выделена ради тестируемости.
 * passed = !hardFail && score >= MIN_SECURITY_SCORE.
 */
export function evaluateSecurity(
  gmgn: GmgnData,
  rug: RugcheckData,
  bm: BubbleMapsData
): SecurityResult {
  let score = 100;
  let hardFail = false;
  const warnings: string[] = [];
  const sourcesUnavailable: string[] = [];

  // ── GMGN: fees + twitter. Недоступность НЕ штрафуем (Cloudflare на VPS). ──────
  let twitterActive = false;
  if (!gmgn.available) {
    sourcesUnavailable.push('GMGN');
  } else {
    twitterActive = gmgn.hasTwitter;
    if (gmgn.totalFeesSol < config.security.minGmgnFeesSol) {
      score -= PENALTY.gmgnLowFees;
      warnings.push(
        `GMGN fees низкие: ${gmgn.totalFeesSol.toFixed(1)} SOL (мин ${config.security.minGmgnFeesSol})`
      );
    }
    if (!twitterActive) {
      score -= PENALTY.noTwitter;
      warnings.push('Нет Twitter/соц-активности');
    }
  }

  // ── RugCheck: риск-скор + danger-уровень ──────────────────────────────────────
  let rugStatus: string;
  if (!rug.available) {
    sourcesUnavailable.push('RugCheck');
    score -= PENALTY.rugcheckUnavailable;
    warnings.push('RugCheck недоступен (fail-closed)');
    rugStatus = 'unavailable';
  } else {
    const risk = rug.riskScore;
    if (risk === null) {
      rugStatus = 'Unknown';
    } else if (risk >= 60) {
      score -= PENALTY.rugcheckRiskHigh;
      warnings.push(`RugCheck риск ${risk}/100`);
      rugStatus = 'High risk';
    } else if (risk >= 30) {
      score -= PENALTY.rugcheckRiskMed;
      warnings.push(`RugCheck риск ${risk}/100`);
      rugStatus = 'Medium';
    } else {
      rugStatus = 'Good';
    }
    if (rug.hasDanger) {
      score -= PENALTY.rugcheckDanger;
      warnings.push('RugCheck: есть danger-риски');
      if (rugStatus === 'Good' || rugStatus === 'Unknown') rugStatus = 'Danger';
    }
  }

  // ── Honeypot / authorities — жёсткие провалы (источник — RugCheck) ────────────
  const honeypot = rug.honeypot;
  const mintAuthorityActive = rug.mintAuthorityActive;
  const freezeAuthorityActive = rug.freezeAuthorityActive;
  if (honeypot) {
    hardFail = true;
    warnings.push('🍯 Honeypot detected');
  }
  if (mintAuthorityActive) {
    hardFail = true;
    warnings.push('Mint authority активна (можно доминтить)');
  }
  if (freezeAuthorityActive) {
    hardFail = true;
    warnings.push('Freeze authority активна (можно заморозить кошельки)');
  }

  // ── BubbleMaps: децентрализация (fail-closed при недоступности) ───────────────
  let decentralisationScore: number;
  if (!bm.available) {
    sourcesUnavailable.push('BubbleMaps');
    score -= PENALTY.bubblemapsUnavailable;
    warnings.push('BubbleMaps недоступен (fail-closed)');
    decentralisationScore = 0;
  } else {
    decentralisationScore = bm.decentralisationScore;
    if (decentralisationScore < 15) {
      score -= PENALTY.lowDecentralisationHard;
      warnings.push(`Низкая децентрализация: ${decentralisationScore.toFixed(0)}/100`);
    } else if (decentralisationScore < 30) {
      score -= PENALTY.lowDecentralisationMed;
      warnings.push(`Умеренная децентрализация: ${decentralisationScore.toFixed(0)}/100`);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const passed = !hardFail && score >= config.security.minScore;

  return {
    passed,
    score,
    hardFail,
    gmgnFeesSol: gmgn.totalFeesSol,
    rugcheckStatus: rugStatus,
    decentralisationScore,
    twitterActive,
    mintAuthorityActive,
    freezeAuthorityActive,
    honeypot,
    sourcesUnavailable,
    warnings,
  };
}

// ─── Helpers / fallbacks ────────────────────────────────────────────────────────

const FALLBACK_GMGN: GmgnData = { available: false, totalFeesSol: 0, hasTwitter: false };
const FALLBACK_RUGCHECK: RugcheckData = {
  available: false,
  riskScore: null,
  hasDanger: false,
  honeypot: false,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
};
const FALLBACK_BUBBLEMAPS: BubbleMapsData = { available: false, decentralisationScore: 0 };

function settled<T>(r: PromiseSettledResult<T>, fallback: T): T {
  return r.status === 'fulfilled' ? r.value : fallback;
}
