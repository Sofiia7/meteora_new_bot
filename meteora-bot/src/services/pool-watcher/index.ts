import axios from 'axios';
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

      const targetPools = pools.filter((p) => p.feeBps === config.poolWatcher.targetFeeBps);
      const hasTarget = targetPools.length > 0;

      // If we found target pool → notify immediately and stop watching
      if (hasTarget) {
        logger.info(`Found ${config.poolWatcher.targetFeeBps / 100}% fee pool for ${entry.tokenSymbol}`);
        this.stopWatching(tokenAddress);
        for (const cb of this.onFoundCallbacks) cb(tokenAddress, targetPools, true);
        return;
      }

      // No target pool, but alternatives exist — notify once
      if (!entry.notifiedAlternatives && pools.length > 0) {
        entry.notifiedAlternatives = true;
        logger.info(`No 5% pool for ${entry.tokenSymbol}, found ${pools.length} alternatives`);
        for (const cb of this.onFoundCallbacks) cb(tokenAddress, pools, false);
      }
    } catch (err) {
      logger.error(`Pool check error for ${tokenAddress}: ${err}`);
    }
  }

  async fetchPools(tokenAddress: string): Promise<PoolInfo[]> {
    try {
      const resp = await axios.get(`${METEORA_API}/pair/all_with_pagination`, {
        params: { token: tokenAddress, limit: 20, page: 0 },
        timeout: 10000,
      });

      const pairs: MeteoraPair[] = resp.data?.data ?? resp.data?.pairs ?? [];
      return pairs
        .filter((p) => p.mint_x === tokenAddress || p.mint_y === tokenAddress)
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
}
