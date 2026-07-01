import { dexscreenerQ, meteoraQ } from '../../shared/http-queue';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { cacheGet, cacheSet } from '../../shared/redis';
import { Tokens } from '../../shared/repositories';
import { TokenInfo } from '../../shared/types';

/** Окно дедупликации: повторно не уведомляем чаще, чем раз в N секунд. */
const SEEN_WINDOW_SEC = 24 * 60 * 60; // 24 часа

const DEXSCREENER_API = 'https://api.dexscreener.com/token-profiles/latest/v1';

// Живой (проверено вручную) домен Meteora DLMM data-API — не dlmm-api.meteora.ag
// (тот 404 на все пути), см. https://docs.meteora.ag/developer-guides/dlmm/api-reference/overview.
// В отличие от DexScreener token-profiles (только СВЕЖЕ поданные профили — узкое
// окно, легко пропустить старый, но живой токен вроде ANSEM), здесь можно взять
// пулы по всей сети, отсортированные по объёму — независимо от возраста токена.
const METEORA_POOLS_API = 'https://dlmm.datapi.meteora.ag/pools';

/** Мажорные монеты — если ОБЕ стороны пула из этого списка, это не токен-кандидат. */
const MAJOR_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // SOL (wrapped)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export type ScannerCallback = (token: TokenInfo) => void;

export class ScannerService {
  private intervalHandle: NodeJS.Timeout | null = null;
  private callbacks: ScannerCallback[] = [];

  onToken(cb: ScannerCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    logger.info('Scanner started');
    this.scan();
    this.intervalHandle = setInterval(() => this.scan(), config.scanner.intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Scan a specific token by contract address (manual /scan command) */
  async scanToken(address: string): Promise<TokenInfo | null> {
    try {
      return await this.fetchTokenInfo(address);
    } catch (err) {
      logger.error(`Failed to scan token ${address}: ${err}`);
      return null;
    }
  }

  private async scan(): Promise<void> {
    logger.info('Running scanner tick...');
    try {
      const tokens = await this.fetchCandidates();
      for (const token of tokens) {
        // Персистентная дедупликация: переживает рестарты (раньше Set in-memory
        // → после рестарта шквал повторных уведомлений). 24-часовое окно
        // оставляет место для re-notification по новому ATH в Фазе 3.
        if (Tokens.seenWithin(token.address, SEEN_WINDOW_SEC)) continue;
        if (!this.passesFilters(token)) continue;
        // Upsert делает main.ts при onToken, но мы пишем сюда «след» сразу,
        // чтобы между нашим логом и записью main.ts не пролез повторный
        // тик scanner.
        Tokens.upsert(token);
        logger.info(`Found token: ${token.symbol} (${token.address}) mcap=$${token.marketCap} vol=$${token.volume24h}`);
        for (const cb of this.callbacks) cb(token);
      }
    } catch (err) {
      logger.error(`Scanner error: ${err}`);
    }
  }

  private passesFilters(token: TokenInfo): boolean {
    return passesScannerFilters(token);
  }

  /**
   * Кандидаты из двух независимых источников:
   *  - DexScreener token-profiles — только свежеПОДАННЫЕ профили (узкое окно,
   *    пропускает старые, но живые токены);
   *  - Meteora DLMM pools по всей сети, топ по объёму — ловит активные пулы
   *    независимо от возраста токена (см. кейс ANSEM: старый токен, но #2
   *    по 24ч-объёму среди ВСЕХ DLMM-пулов сети).
   * Источники независимы: ошибка одного не блокирует другой. Дедуп по адресу.
   */
  private async fetchCandidates(): Promise<TokenInfo[]> {
    const [dexscreenerTokens, meteoraTokens] = await Promise.all([
      this.fetchLatestSolanaTokens().catch((err) => {
        logger.error(`DexScreener candidates fetch error: ${err}`);
        return [] as TokenInfo[];
      }),
      this.fetchTopMeteoraTokens().catch((err) => {
        logger.error(`Meteora pools fetch error: ${err}`);
        return [] as TokenInfo[];
      }),
    ]);

    const merged = new Map<string, TokenInfo>();
    for (const t of [...dexscreenerTokens, ...meteoraTokens]) {
      if (!merged.has(t.address)) merged.set(t.address, t);
    }
    return [...merged.values()];
  }

  private async fetchTopMeteoraTokens(): Promise<TokenInfo[]> {
    const cacheKey = 'scanner:meteora_pools';
    const cached = await cacheGet(cacheKey);
    if (cached) return JSON.parse(cached) as TokenInfo[];

    const resp = await meteoraQ.get<{ data: MeteoraDlmmPool[] }>(METEORA_POOLS_API, {
      params: { page: 1, page_size: 50, sort_by: 'volume_24h:desc' },
      timeout: 10000,
    });
    const pools = resp.data?.data ?? [];
    const tokens = pools
      .map(mapMeteoraPoolToTokenInfo)
      .filter((t): t is TokenInfo => t !== null);

    await cacheSet(cacheKey, JSON.stringify(tokens), 240); // cache 4 min, как DexScreener
    return tokens;
  }

  private async fetchLatestSolanaTokens(): Promise<TokenInfo[]> {
    const cacheKey = 'scanner:latest_profiles';
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return JSON.parse(cached) as TokenInfo[];
    }

    // DexScreener token profiles endpoint returns recent tokens
    const resp = await dexscreenerQ.get(DEXSCREENER_API, { timeout: 10000 });
    const profiles: Array<{
      tokenAddress: string;
      chainId: string;
    }> = resp.data ?? [];

    const solanaAddresses = profiles
      .filter((p) => p.chainId === 'solana')
      .map((p) => p.tokenAddress)
      .slice(0, 30);

    const tokens: TokenInfo[] = [];
    // Fetch pair data in batches of 10
    for (let i = 0; i < solanaAddresses.length; i += 10) {
      const batch = solanaAddresses.slice(i, i + 10);
      const batchTokens = await this.fetchPairDataBatch(batch);
      tokens.push(...batchTokens);
      if (i + 10 < solanaAddresses.length) {
        await sleep(500);
      }
    }

    await cacheSet(cacheKey, JSON.stringify(tokens), 240); // cache 4 min
    return tokens;
  }

  private async fetchPairDataBatch(addresses: string[]): Promise<TokenInfo[]> {
    const url = `https://api.dexscreener.com/tokens/v1/solana/${addresses.join(',')}`;
    const resp = await dexscreenerQ.get(url, { timeout: 10000 });
    const pairs: DexScreenerPair[] = resp.data ?? [];
    return pairs.map(pairToTokenInfo).filter((t): t is TokenInfo => t !== null);
  }

  async fetchTokenInfo(address: string): Promise<TokenInfo | null> {
    const cacheKey = `scanner:token:${address}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return JSON.parse(cached) as TokenInfo;

    const url = `https://api.dexscreener.com/tokens/v1/solana/${address}`;
    const resp = await dexscreenerQ.get(url, { timeout: 10000 });
    const pairs: DexScreenerPair[] = resp.data ?? [];
    if (!pairs.length) return null;

    // Pick highest liquidity pair
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const token = pairToTokenInfo(best);
    if (token) {
      await cacheSet(cacheKey, JSON.stringify(token), 120);
    }
    return token;
  }
}

/**
 * Базовые фильтры сканера (чистая функция — вынесена ради тестов). Полный
 * chart-health (ATH/RSI/volume score) считается отдельно в ChartHealthAnalyzer
 * ПОСЛЕ сканера, чтобы тот же analyzer переиспользовался при ATH-re-notify.
 */
export function passesScannerFilters(token: TokenInfo): boolean {
  if (token.marketCap < config.scanner.minMarketCap) return false;
  if (token.volume24h < config.scanner.minVolume24h) return false;
  if (token.chainId !== 'solana') return false;
  return true;
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  marketCap?: number;
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
}

function pairToTokenInfo(pair: DexScreenerPair): TokenInfo | null {
  if (!pair?.baseToken?.address) return null;
  return {
    address: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    marketCap: pair.marketCap ?? 0,
    volume24h: pair.volume?.h24 ?? 0,
    priceUsd: parseFloat(pair.priceUsd ?? '0'),
    priceChange24h: pair.priceChange?.h24 ?? 0,
    ath: 0, // DexScreener doesn't expose ATH directly; fetched separately
    athDate: '',
    liquidity: pair.liquidity?.usd ?? 0,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    chainId: pair.chainId,
    createdAt: pair.pairCreatedAt ?? 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MeteoraTokenSide {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  is_verified: boolean;
  holders: number;
  freeze_authority_disabled: boolean;
  total_supply: number;
  price: number;
  market_cap: number;
}

export interface MeteoraDlmmPool {
  address: string;
  name: string;
  token_x: MeteoraTokenSide;
  token_y: MeteoraTokenSide;
  created_at: number;
  pool_config: { bin_step: number; base_fee_pct: number };
  tvl: number;
  volume: { '30m': number; '1h': number; '2h': number; '4h': number; '12h': number; '24h': number };
  is_blacklisted: boolean;
}

/**
 * Пул Meteora DLMM (dlmm.datapi.meteora.ag) → кандидат TokenInfo для сканера.
 * Берём НЕ-мажорную сторону пула (не SOL/USDC/USDT) как токен; если обе
 * стороны мажорные (SOL-USDC) или пул в блэклисте — не кандидат (null).
 */
export function mapMeteoraPoolToTokenInfo(pool: MeteoraDlmmPool): TokenInfo | null {
  if (pool.is_blacklisted) return null;

  const xIsMajor = MAJOR_MINTS.has(pool.token_x.address);
  const yIsMajor = MAJOR_MINTS.has(pool.token_y.address);
  if (xIsMajor && yIsMajor) return null;
  const token = xIsMajor ? pool.token_y : pool.token_x;

  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    marketCap: token.market_cap,
    volume24h: pool.volume['24h'],
    priceUsd: token.price,
    priceChange24h: 0,
    ath: 0,
    athDate: '',
    liquidity: pool.tvl,
    pairAddress: pool.address,
    dexId: 'meteora',
    chainId: 'solana',
    createdAt: pool.created_at,
  };
}
