import { dexscreenerQ } from '../../shared/http-queue';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { PoolInfo } from '../../shared/types';

// Источник пулов — DexScreener: dlmm-api.meteora.ag сейчас отдаёт 404 на все эндпоинты,
// а DexScreener надёжно возвращает пары токена с пометкой dexId=meteora + labels=[DLMM].
const DEXSCREENER_TOKEN_PAIRS = 'https://api.dexscreener.com/token-pairs/v1/solana';
const DEXSCREENER_PAIR = 'https://api.dexscreener.com/latest/dex/pairs/solana';

export type PoolFoundCallback = (tokenAddress: string, pools: PoolInfo[]) => void;
/** foundAny = были ли вообще показаны пулы (для корректного текста таймаута). */
export type PoolTimeoutCallback = (
  tokenAddress: string,
  tokenSymbol: string,
  foundAny: boolean
) => void;
export type PoolNoneCallback = (tokenAddress: string, tokenSymbol: string) => void;

interface WatchEntry {
  tokenAddress: string;
  tokenSymbol: string;
  startedAt: number;
  intervalHandle: NodeJS.Timeout;
  timeoutHandle: NodeJS.Timeout;
  /** Адреса пулов, о которых уже уведомили — чтобы не спамить тем же набором. */
  notifiedPoolAddrs: Set<string>;
  /** Сообщили ли уже «пулов пока нет» (один раз на старте наблюдения). */
  notifiedNoPools: boolean;
}

export class PoolWatcher {
  private watching = new Map<string, WatchEntry>();
  private onFoundCallbacks: PoolFoundCallback[] = [];
  private onTimeoutCallbacks: PoolTimeoutCallback[] = [];
  private onNoneCallbacks: PoolNoneCallback[] = [];

  onPoolFound(cb: PoolFoundCallback): void {
    this.onFoundCallbacks.push(cb);
  }

  onTimeout(cb: PoolTimeoutCallback): void {
    this.onTimeoutCallbacks.push(cb);
  }

  /** Первая проверка не нашла пулов — сообщаем пользователю, что наблюдаем. */
  onNoPools(cb: PoolNoneCallback): void {
    this.onNoneCallbacks.push(cb);
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
      const e = this.watching.get(tokenAddress);
      const foundAny = e ? e.notifiedPoolAddrs.size > 0 : false;
      this.stopWatching(tokenAddress);
      logger.info(`Pool watch timeout for ${tokenSymbol} (foundAny=${foundAny})`);
      for (const cb of this.onTimeoutCallbacks) cb(tokenAddress, tokenSymbol, foundAny);
    }, config.poolWatcher.watchTimeoutMs);

    this.watching.set(tokenAddress, {
      tokenAddress,
      tokenSymbol,
      startedAt,
      intervalHandle,
      timeoutHandle,
      notifiedPoolAddrs: new Set<string>(),
      notifiedNoPools: false,
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
      if (pools.length === 0) {
        // Пулов пока нет — продолжаем ждать до таймаута, но ОДИН раз явно сообщаем
        // пользователю, что наблюдаем (иначе непонятно, что происходит).
        if (!entry.notifiedNoPools) {
          entry.notifiedNoPools = true;
          for (const cb of this.onNoneCallbacks) cb(tokenAddress, entry.tokenSymbol);
        }
        return;
      }

      // Решение заказчика: НЕ фильтруем по стратегии и по типу. Показываем ВСЕ пулы
      // Meteora по токену (DLMM + DAMM V2), а человек выбирает.
      //
      // Анти-спам: первый раз уведомляем всегда; повторно — только если появился
      // ЗНАЧИМЫЙ новый пул (TVL ≥ renotifyMinTvl). Иначе мелкие свежие DAMM-пулы
      // ($0–14) триггерили дубли всего списка. Все текущие пулы помечаем виденными.
      const firstTime = entry.notifiedPoolAddrs.size === 0;
      const significantNew = pools.some(
        (p) => !entry.notifiedPoolAddrs.has(p.address) && p.tvl >= config.poolWatcher.renotifyMinTvl
      );
      for (const p of pools) entry.notifiedPoolAddrs.add(p.address);
      if (!firstTime && !significantNew) return;

      logger.info(
        `Pools for ${entry.tokenSymbol}: ${pools.length} Meteora pool(s), notifying for manual choice`
      );
      // Watch НЕ останавливаем — вход/отмену решает пользователь (кнопки):
      //   • «войти» → main.ts вызовет stopWatching при открытии позиции;
      //   • «не входить» → main.ts вызовет stopWatching + cancel;
      //   • «ждать ещё» → продолжаем поллинг, повторно уведомим только о новых пулах.
      for (const cb of this.onFoundCallbacks) cb(tokenAddress, pools);
    } catch (err) {
      logger.error(`Pool check error for ${tokenAddress}: ${err}`);
    }
  }

  async fetchPools(tokenAddress: string): Promise<PoolInfo[]> {
    try {
      const resp = await dexscreenerQ.get<DexPair[]>(
        `${DEXSCREENER_TOKEN_PAIRS}/${tokenAddress}`,
        { timeout: 10000 }
      );
      const pairs: DexPair[] = Array.isArray(resp.data) ? resp.data : [];
      return pairs
        .filter((p) => p.dexId === 'meteora') // все типы пулов Meteora (DLMM + DAMM V2)
        .map((p) => ({
          address: p.pairAddress,
          tokenMint: tokenAddress,
          poolType: labelToPoolType(p.labels),
          // DexScreener не отдаёт fee-тир и bin_step, а dlmm-api сейчас 404.
          // 0 = «неизвестно»; бот показывает тип пула без тира (см. notifyPoolFound).
          feeBps: 0,
          binStep: 0,
          tvl: p.liquidity?.usd ?? 0,
          activeBinId: 0,
          currentPrice: parseFloat(p.priceUsd ?? '0') || 0,
        }))
        .sort((a, b) => b.tvl - a.tvl);
    } catch (err) {
      logger.error(`fetchPools error: ${err}`);
      return [];
    }
  }
}

interface DexPair {
  dexId: string;
  pairAddress: string;
  labels?: string[];
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/** Метка DexScreener → человекочитаемый тип пула Meteora. */
function labelToPoolType(labels?: string[]): string {
  const l = labels ?? [];
  if (l.includes('DLMM')) return 'DLMM';
  if (l.includes('DYN2')) return 'DAMM V2';
  if (l.includes('DYN')) return 'DAMM';
  return l[0] ?? 'Meteora';
}

/**
 * Текущий TVL (USD) одного пула по адресу пары (DexScreener). Используется
 * panic-detector'ом (фактор F5 tvl_drop). null при ошибке/отсутствии данных.
 */
export async function fetchPoolTvl(poolAddress: string): Promise<number | null> {
  try {
    const resp = await dexscreenerQ.get<{ pairs?: DexPair[]; pair?: DexPair }>(
      `${DEXSCREENER_PAIR}/${poolAddress}`,
      { timeout: 8000 }
    );
    const pair = resp.data?.pairs?.[0] ?? resp.data?.pair;
    const tvl = pair?.liquidity?.usd;
    return typeof tvl === 'number' ? tvl : null;
  } catch (err) {
    logger.warn(`fetchPoolTvl error for ${poolAddress}: ${err}`);
    return null;
  }
}
