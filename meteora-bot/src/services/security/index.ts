import { gmgnQ, rugcheckQ, bubblemapsQ } from '../../shared/http-queue';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { cacheGet, cacheSet } from '../../shared/redis';
import { SecurityResult } from '../../shared/types';

const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';
const GMGN_API = 'https://gmgn.ai/defi/router/v1/sol/token_info';
const BUBBLEMAPS_API = 'https://api-legacy.bubblemaps.io/map-metadata';

export class SecurityChecker {
  async check(tokenAddress: string): Promise<SecurityResult> {
    const cacheKey = `security:${tokenAddress}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return JSON.parse(cached) as SecurityResult;

    logger.info(`Security check for ${tokenAddress}`);

    const [gmgn, rugcheck, bubbleMaps] = await Promise.allSettled([
      this.checkGmgn(tokenAddress),
      this.checkRugcheck(tokenAddress),
      this.checkBubbleMaps(tokenAddress),
    ]);

    const warnings: string[] = [];

    // GMGN: Total Fees check
    const gmgnData = gmgn.status === 'fulfilled' ? gmgn.value : null;
    const gmgnFeesSol = gmgnData?.totalFeesSol ?? 0;
    if (gmgnFeesSol < config.security.minGmgnFeesSol) {
      warnings.push(`GMGN fees low: ${gmgnFeesSol.toFixed(1)} SOL (min: ${config.security.minGmgnFeesSol})`);
    }

    // RugCheck: status
    const rugData = rugcheck.status === 'fulfilled' ? rugcheck.value : null;
    const rugStatus = rugData?.status ?? 'unknown';
    if (rugStatus !== 'Good' && rugStatus !== 'good') {
      warnings.push(`RugCheck status: ${rugStatus}`);
    }

    // BubbleMaps: holder concentration
    const bmData = bubbleMaps.status === 'fulfilled' ? bubbleMaps.value : null;
    const holderConcentration = bmData?.topHoldersPercent ?? 100;
    if (holderConcentration > 50) {
      warnings.push(`High holder concentration: ${holderConcentration.toFixed(1)}%`);
    }

    // Twitter: basic check via GMGN social data
    const twitterActive = gmgnData?.hasTwitter ?? false;
    if (!twitterActive) {
      warnings.push('No Twitter/social activity found');
    }

    const passed = warnings.length === 0;

    const result: SecurityResult = {
      passed,
      gmgnFeesSol,
      rugcheckStatus: rugStatus,
      holderConcentration,
      twitterActive,
      warnings,
    };

    // Cache for 10 minutes
    await cacheSet(cacheKey, JSON.stringify(result), 600);
    return result;
  }

  private async checkGmgn(tokenAddress: string): Promise<{ totalFeesSol: number; hasTwitter: boolean }> {
    try {
      const resp = await gmgnQ.get(`${GMGN_API}/${tokenAddress}`, { timeout: 8000 });
      const data = resp.data?.data ?? {};
      return {
        totalFeesSol: parseFloat(data.total_fees_sol ?? data.fee_sol ?? '0') || 0,
        hasTwitter: !!(data.twitter || data.social?.twitter),
      };
    } catch (err) {
      logger.warn(`GMGN check failed for ${tokenAddress}: ${err}`);
      return { totalFeesSol: 0, hasTwitter: false };
    }
  }

  private async checkRugcheck(tokenAddress: string): Promise<{ status: string }> {
    try {
      const resp = await rugcheckQ.get(`${RUGCHECK_API}/tokens/${tokenAddress}/report/summary`, { timeout: 8000 });
      return { status: resp.data?.score_normalised >= 80 ? 'Good' : (resp.data?.status ?? 'unknown') };
    } catch (err) {
      logger.warn(`RugCheck failed for ${tokenAddress}: ${err}`);
      return { status: 'unknown' };
    }
  }

  private async checkBubbleMaps(tokenAddress: string): Promise<{ topHoldersPercent: number }> {
    try {
      const resp = await bubblemapsQ.get(`${BUBBLEMAPS_API}?token=${tokenAddress}&chain=sol`, { timeout: 8000 });
      const holders: Array<{ percentage: number }> = resp.data?.nodes ?? [];
      // Top 10 holders concentration
      const top10 = holders
        .sort((a, b) => b.percentage - a.percentage)
        .slice(0, 10)
        .reduce((sum, h) => sum + h.percentage, 0);
      return { topHoldersPercent: top10 };
    } catch (err) {
      logger.warn(`BubbleMaps failed for ${tokenAddress}: ${err}`);
      return { topHoldersPercent: 0 };
    }
  }

  formatResult(result: SecurityResult, symbol: string): string {
    const status = result.passed ? '✅ Прошёл' : '⚠️ Есть предупреждения';
    const lines = [
      `🔐 *Security: ${symbol}* — ${status}`,
      `• GMGN fees: ${result.gmgnFeesSol.toFixed(1)} SOL`,
      `• RugCheck: ${result.rugcheckStatus}`,
      `• Топ холдеры: ${result.holderConcentration.toFixed(1)}%`,
      `• Twitter: ${result.twitterActive ? 'есть' : 'нет'}`,
    ];
    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('⚠️ *Предупреждения:*');
      for (const w of result.warnings) lines.push(`  — ${w}`);
    }
    return lines.join('\n');
  }
}
