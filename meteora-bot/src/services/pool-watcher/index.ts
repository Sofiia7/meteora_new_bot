import { meteoraQ } from '../../shared/http-queue';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { PoolInfo } from '../../shared/types';

const METEORA_API = 'https://dlmm-api.meteora.ag';

export type PoolFoundCallback = (tokenAddress: string, pools: PoolInfo[], hasTargetFee: boolean) => void;
export type PoolTimeoutCallback = (tokenAddress: string, tokenSymbol: string) => void;

interface WatchEntry {
  tokenAddress: string;
  tokenSymbol: string;
  startedAt: number;
  intervalHandle: NodeJS.Timeout;
  timeoutHandle: NodeJS.Timeout;
  notifiedAlternatives: boolean;
}

export class PoolWatcher {
  private watching = new Map<string, WatchEntry>();
  private onFoundCallbacks: PoolFoundCallback[] = [];
  private onTimeoutCallbacks: PoolTimeoutCallback[] = [];

  onPoolFound(cb: PoolFoundCallback): void {
    this.onFoundCallbacks.push(cb);
  }

  onTimeout(cb: PoolTimeoutCallback): void {
    this.onTimeoutCallbacks.push(cb);
  }

  watch(tokenAddress: string, tokenSymbol: string): void {
    if (this.watching.has(tokenAddress)) {
      logger.info(`Already watching ${tokenAddress}`);
      return;
    }

    logger.info(`Watching pools for ${tokenSymbol} (${tokenAddress})`);

    const startedAt = Date.now();

    const intervalHandle = setInterval(
      () => this.checkPools(tokenAddress),
      config.poolWatcher.checkIntervalMs
    );

    const timeoutHandle = setTimeout(() => {
      this.stopWatching(tokenAddress);
      logger.info(`Pool watch timeout for ${tokenSymbol}`);
      for (const cb of this.onTimeoutCallbacks) cb(tokenAddress, tokenSymbol);
    }, config.poolWatcher.watchTimeoutMs);

    this.watching.set(tokenAddress, {
      tokenAddress,
      tokenSymbol,
      startedAt,
      intervalHandle,
      timeoutHandle,
      notifiedAlternatives: false,
    });

    // Run immediately on first check
    this.checkPools(tokenAddress);
  }

  stopWatching(tokenAddress: string): void {
    const entry = this.watching.get(tokenAddress);
    if (!entry) return;
    clearInterval(entry.intervalHandle);
    clearTimeout(entry.timeoutHandle);
    this.watching.delete(tokenAddress);
    logger.info(`Stopped watching ${tokenAddress}`);
  }

  isWatching(tokenAddress: string): boolean {
    return this.watching.has(tokenAddress);
  }

  private async checkPools(tokenAddress: string): Promise<void> {
    const entry = this.watching.get(tokenAddress);
    if (!entry) return;

    try {
      const pools = await this.fetchPools(tokenAddress);
      if (pools.length === 0) return;

      // ТЗ 2.2: идеальный пул = DLMM-Dynamic + fee 5% (500 bps) + binStep 80/100/125.
      // Раньше код фильтровал только по fee и игнорировал binStep/тип.
      const preferred = new Set(config.poolWatcher.preferredBinSteps);
      const isIdealPool = (p: PoolInfo): boolean =>
        p.feeBps === config.poolWatcher.targetFeeBps && preferred.has(p.binStep);

      const idealPools = pools.filter(isIdealPool);
      if (idealPools.length > 0) {
        logger.info(
          `Found ideal pool for ${entry.tokenSymbol}: fee=${config.poolWatcher.targetFeeBps / 100}%, ` +
            `binStep ∈ {${[...preferred].join(',')}}`
        );
        this.stopWatching(tokenAddress);
        for (const cb of this.onFoundCallbacks) cb(tokenAddress, idealPools, true);
        return;
      }

      // Альтернативы существуют, но без нужных параметров — уведомляем один раз
      // и продолжаем ждать идеальный пул до таймаута (2 часа).
      if (!entry.notifiedAlternatives && pools.length > 0) {
        entry.notifiedAlternatives = true;
        logger.info(
          `No ideal pool for ${entry.tokenSymbol}, found ${pools.length} alternative pools`
        );
        for (const cb of this.onFoundCallbacks) cb(tokenAddress, pools, false);
      }
    } catch (err) {
      logger.error(`Pool check error for ${tokenAddress}: ${err}`);
    }
  }

  async fetchPools(tokenAddress: string): Promise<PoolInfo[]> {
    try {
      const resp = await meteoraQ.get<{ data?: MeteoraPair[]; pairs?: MeteoraPair[] }>(
        `${METEORA_API}/pair/all_with_pagination`,
        {
          params: { token: tokenAddress, limit: 20, page: 0 },
          timeout: 10000,
        }
      );

      const pairs: MeteoraPair[] = resp.data?.data ?? resp.data?.pairs ?? [];
      return pairs
        .filter((p) => {
          if (p.mint_x !== tokenAddress && p.mint_y !== tokenAddress) return false;
          // ТЗ требует DLMM-Dynamic; всё остальное (AMM v1, DAMM) отбрасываем.
          // Поле точно называется по-разному в зависимости от ответа API —
          // принимаем оба варианта, как минимум исключаем AMM.
          const tp = (p.pool_type ?? p.type ?? '').toString().toUpperCase();
          if (tp && tp !== 'DLMM' && tp !== 'DYNAMIC') return false;
          return true;
        })
        .map((p) => ({
          address: p.address,
          tokenMint: tokenAddress,
          feeBps: Math.round(parseFloat(p.base_fee_percentage ?? '0') * 100),
          binStep: p.bin_step ?? 0,
          tvl: parseFloat(p.liquidity ?? '0'),
          activeBinId: p.active_bin_id ?? 0,
          currentPrice: parseFloat(p.current_price ?? '0'),
        }))
        .sort((a, b) => b.tvl - a.tvl);
    } catch (err) {
      logger.error(`fetchPools error: ${err}`);
      return [];
    }
  }
}

interface MeteoraPair {
  address: string;
  mint_x: string;
  mint_y: string;
  base_fee_percentage?: string;
  bin_step?: number;
  liquidity?: string;
  active_bin_id?: number;
  current_price?: string;
  pool_type?: string;
  type?: string;
}
