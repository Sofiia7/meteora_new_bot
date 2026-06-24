import { gmgnQ, rugcheckQ, bubblemapsQ } from '../../shared/http-queue';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { cacheGet, cacheSet } from '../../shared/redis';
import { SecurityResult } from '../../shared/types';

const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';
const GMGN_API = 'https://gmgn.ai/defi/router/v1/sol/token_info';
const BUBBLEMAPS_API = 'https://api-legacy.bubblemaps.io/map-metadata';

// ─── Веса скоринга (0–100). Hard-fail'ы (honeypot/authority/danger) перебивают скор. ──
const PENALTY = {
  gmgnUnavailable: 20,
  gmgnLowFees: 25,
  rugcheckUnavailable: 40, // fail-closed: не смогли проверить риски → большой штраф
  rugcheckWarn: 20,
  rugcheckLowScore: 15,
  bubblemapsUnavailable: 40, // fail-closed: не смогли проверить холдеров → большой штраф
  highConcentration: 25,
  noTwitter: 10, // мягкий минус (решение заказчика)
};

export interface GmgnData {
  available: boolean;
  totalFeesSol: number;
  hasTwitter: boolean;
  honeypot: boolean;
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
}

export interface RugcheckData {
  available: boolean;
  scoreNormalised: number | null;
  level: 'good' | 'warn' | 'danger' | 'unknown';
  honeypot: boolean;
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
}

export interface BubbleMapsData {
  available: boolean;
  topHoldersPercent: number;
}

export class SecurityChecker {
  /**
   * Проверка безопасности токена. Score-based + fail-closed (Фаза 4).
   * @param opts.bypassCache — для периодического re-check активных позиций (panic F4),
   *        где нужен свежий ответ, а не закэшированный на входе.
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

    const gmgnData = settled(gmgn, FALLBACK_GMGN);
    const rugData = settled(rugcheck, FALLBACK_RUGCHECK);
    const bmData = settled(bubbleMaps, FALLBACK_BUBBLEMAPS);

    const result = evaluateSecurity(gmgnData, rugData, bmData);

    // Кэшируем и свежие проверки тоже (10 минут) — следующий re-check возьмёт из кэша
    // только если bypassCache не выставлен.
    await cacheSet(cacheKey, JSON.stringify(result), 600);
    return result;
  }

  // ─── Источники ───────────────────────────────────────────────────────────────
  //
  // ВНИМАНИЕ: точные имена полей в ответах GMGN/RugCheck/BubbleMaps НЕ верифицированы
  // против живого API (нужен прогон с ключами на реальном токене — открытый пункт
  // Фазы 4). Парсинг намеренно защитный: неизвестное поле ⇒ false/недоступно, а не
  // ложный «всё ок». Authority/honeypot основной источник — RugCheck risks.

  private async checkGmgn(tokenAddress: string): Promise<GmgnData> {
    try {
      const resp = await gmgnQ.get(`${GMGN_API}/${tokenAddress}`, { timeout: 8000 });
      const d = resp.data?.data ?? {};
      return {
        available: true,
        totalFeesSol: parseFloat(d.total_fees_sol ?? d.fee_sol ?? '0') || 0,
        hasTwitter: !!(d.twitter || d.social?.twitter || d.twitter_username),
        honeypot: truthy(d.is_honeypot ?? d.honeypot),
        // GMGN отдаёт «renounced_*» (true = authority отозвана). Активна = !renounced.
        mintAuthorityActive: authorityActive(d.mint_authority, d.renounced_mint),
        freezeAuthorityActive: authorityActive(d.freeze_authority, d.renounced_freeze_account),
      };
    } catch (err) {
      logger.warn(`GMGN check failed for ${tokenAddress}: ${err}`);
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
      const riskNames = risks.map((r) => (r.name ?? '').toLowerCase());
      const has = (kw: string): boolean => riskNames.some((n) => n.includes(kw));
      const scoreNormalised =
        typeof data.score_normalised === 'number' ? data.score_normalised : null;
      const danger = risks.some((r) => (r.level ?? '').toLowerCase() === 'danger');
      const warn = risks.some((r) => (r.level ?? '').toLowerCase() === 'warn');

      return {
        available: true,
        scoreNormalised,
        level: danger ? 'danger' : warn ? 'warn' : 'good',
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
      const holders: Array<{ percentage: number }> = resp.data?.nodes ?? [];
      // Если узлов нет — данные неполные, это НЕ «0% концентрация = отлично».
      if (holders.length === 0) return { ...FALLBACK_BUBBLEMAPS };
      const top10 = holders
        .slice()
        .sort((a, b) => b.percentage - a.percentage)
        .slice(0, 10)
        .reduce((sum, h) => sum + h.percentage, 0);
      return { available: true, topHoldersPercent: top10 };
    } catch (err) {
      logger.warn(`BubbleMaps failed for ${tokenAddress}: ${err}`);
      return { ...FALLBACK_BUBBLEMAPS };
    }
  }
}

/**
 * Чистая (без I/O) функция скоринга — выделена ради тестируемости и чтобы отделить
 * сетевые источники от логики решения. Решение: passed = !hardFail && score>=min.
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

  // ── GMGN: fees + доступность ──────────────────────────────────────────────
  if (!gmgn.available) {
    sourcesUnavailable.push('GMGN');
    score -= PENALTY.gmgnUnavailable;
    warnings.push('GMGN недоступен');
  } else if (gmgn.totalFeesSol < config.security.minGmgnFeesSol) {
    score -= PENALTY.gmgnLowFees;
    warnings.push(
      `GMGN fees низкие: ${gmgn.totalFeesSol.toFixed(1)} SOL (мин ${config.security.minGmgnFeesSol})`
    );
  }

  // ── RugCheck: уровень риска + нормализованный скор ─────────────────────────
  let rugStatus: string;
  if (!rug.available) {
    sourcesUnavailable.push('RugCheck');
    score -= PENALTY.rugcheckUnavailable;
    warnings.push('RugCheck недоступен (fail-closed)');
    rugStatus = 'unavailable';
  } else {
    if (rug.level === 'danger') {
      hardFail = true;
      warnings.push('RugCheck: DANGER');
      rugStatus = 'Danger';
    } else if (rug.level === 'warn') {
      score -= PENALTY.rugcheckWarn;
      warnings.push('RugCheck: warn');
      rugStatus = 'Warn';
    } else {
      rugStatus = rug.scoreNormalised !== null && rug.scoreNormalised >= 80 ? 'Good' : 'Unknown';
    }
    if (rug.scoreNormalised !== null && rug.scoreNormalised < 50) {
      score -= PENALTY.rugcheckLowScore;
      warnings.push(`RugCheck score ${rug.scoreNormalised}/100`);
    }
  }

  // ── Honeypot / authorities — жёсткие провалы (любой источник) ──────────────
  const honeypot = gmgn.honeypot || rug.honeypot;
  const mintAuthorityActive = gmgn.mintAuthorityActive || rug.mintAuthorityActive;
  const freezeAuthorityActive = gmgn.freezeAuthorityActive || rug.freezeAuthorityActive;
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

  // ── BubbleMaps: концентрация холдеров (fail-closed) ────────────────────────
  let holderConcentration: number;
  if (!bm.available) {
    sourcesUnavailable.push('BubbleMaps');
    score -= PENALTY.bubblemapsUnavailable;
    warnings.push('BubbleMaps недоступен (fail-closed)');
    holderConcentration = 100; // неизвестно ⇒ считаем худшим, не «0% = отлично»
  } else {
    holderConcentration = bm.topHoldersPercent;
    if (holderConcentration > config.security.maxHolderConcentrationPct) {
      score -= PENALTY.highConcentration;
      warnings.push(`Высокая концентрация холдеров: ${holderConcentration.toFixed(1)}%`);
    }
  }

  // ── Twitter — мягкий минус ────────────────────────────────────────────────
  const twitterActive = gmgn.hasTwitter;
  if (!twitterActive) {
    score -= PENALTY.noTwitter;
    warnings.push('Нет Twitter/соц-активности');
  }

  score = Math.max(0, Math.min(100, score));
  const passed = !hardFail && score >= config.security.minScore;

  return {
    passed,
    score,
    hardFail,
    gmgnFeesSol: gmgn.totalFeesSol,
    rugcheckStatus: rugStatus,
    holderConcentration,
    twitterActive,
    mintAuthorityActive,
    freezeAuthorityActive,
    honeypot,
    sourcesUnavailable,
    warnings,
  };
}

// ─── Helpers / fallbacks ────────────────────────────────────────────────────────

const FALLBACK_GMGN: GmgnData = {
  available: false,
  totalFeesSol: 0,
  hasTwitter: false,
  honeypot: false,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
};
const FALLBACK_RUGCHECK: RugcheckData = {
  available: false,
  scoreNormalised: null,
  level: 'unknown',
  honeypot: false,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
};
const FALLBACK_BUBBLEMAPS: BubbleMapsData = { available: false, topHoldersPercent: 100 };

function settled<T>(r: PromiseSettledResult<T>, fallback: T): T {
  return r.status === 'fulfilled' ? r.value : fallback;
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Активна ли authority. Источники описывают её по-разному:
 *  - явный адрес authority (непусто ⇒ активна),
 *  - флаг renounced (true ⇒ отозвана ⇒ НЕ активна).
 * Неизвестно ⇒ false (защитно: не плодим ложные hard-fail; реальный руг ловит RugCheck).
 */
function authorityActive(authorityField: unknown, renouncedField: unknown): boolean {
  if (typeof renouncedField === 'boolean') return !renouncedField;
  if (typeof authorityField === 'string') return authorityField.length > 0;
  if (authorityField === null) return false;
  return false;
}
