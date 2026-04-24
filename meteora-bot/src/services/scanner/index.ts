import axios from 'axios';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { cacheGet, cacheSet } from '../../shared/redis';
import { TokenInfo } from '../../shared/types';

const DEXSCREENER_API = 'https://api.dexscreener.com/token-profiles/latest/v1';
const DEXSCREENER_SEARCH = 'https://api.dexscreener.com/latest/dex/search';

export type ScannerCallback = (token: TokenInfo) => void;

export class ScannerService {
  private intervalHandle: NodeJS.Timeout | null = null;
  private seenTokens = new Set<string>();
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
    logger.info('Running DexScreener scan...');
    try {
      const tokens = await this.fetchLatestSolanaTokens();
      for (const token of tokens) {
        if (this.seenTokens.has(token.address)) continue;
        if (!this.passesFilters(token)) continue;
        this.seenTokens.add(token.address);
        logger.info(`Found token: ${token.symbol} (${token.address}) mcap=$${token.marketCap} vol=$${token.volume24h}`);
        for (const cb of this.callbacks) cb(token);
      }
    } catch (err) {
      logger.error(`Scanner error: ${err}`);
    }
  }

  private passesFilters(token: TokenInfo): boolean {
    if (token.marketCap < config.scanner.minMarketCap) return false;
    if (token.volume24h < config.scanner.minVolume24h) return false;
    if (token.chainId !== 'solana') return false;
    // Basic chart health: token not already at extreme ATH distance
    const athDistance = token.ath > 0 ? (token.priceUsd / token.ath) : 1;
    if (athDistance < 0.01) return false; // Price collapsed >99% from ATH
    return true;
  }

  private async fetchLatestSolanaTokens(): Promise<TokenInfo[]> {
    const cacheKey = 'scanner:latest_profiles';
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return JSON.parse(cached) as TokenInfo[];
    }

    // DexScreener token profiles endpoint returns recent tokens
    const resp = await axios.get(DEXSCREENER_API, { timeout: 10000 });
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
    const resp = await axios.get(url, { timeout: 10000 });
    const pairs: DexScreenerPair[] = resp.data ?? [];
    return pairs.map(pairToTokenInfo).filter((t): t is TokenInfo => t !== null);
  }

  async fetchTokenInfo(address: string): Promise<TokenInfo | null> {
    const cacheKey = `scanner:token:${address}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return JSON.parse(cached) as TokenInfo;

    const url = `https://api.dexscreener.com/tokens/v1/solana/${address}`;
    const resp = await axios.get(url, { timeout: 10000 });
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
