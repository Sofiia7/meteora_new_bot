export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  marketCap: number;
  volume24h: number;
  priceUsd: number;
  priceChange24h: number;
  ath: number;
  athDate: string;
  liquidity: number;
  pairAddress: string;
  dexId: string;
  chainId: string;
  createdAt: number;
}

export interface SecurityResult {
  passed: boolean;
  /** Композитный скор безопасности 0–100 (Фаза 4). passed = !hardFail && score>=min. */
  score: number;
  /** Жёсткий провал: honeypot / активные authority / RugCheck danger. Перебивает score. */
  hardFail: boolean;
  gmgnFeesSol: number;
  rugcheckStatus: string;
  /** BubbleMaps decentralisation_score 0–100 (выше = лучше). 0 если источник недоступен. */
  decentralisationScore: number;
  twitterActive: boolean;
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  honeypot: boolean;
  /** Источники, что не ответили — fail-closed: недоступность критичного источника штрафует скор. */
  sourcesUnavailable: string[];
  warnings: string[];
}

/** Вердикт локальной LLM по токену (Фаза 4.1, опционально, AI_ENABLED). */
export interface AiVerdict {
  risk: 'low' | 'medium' | 'high' | 'unknown';
  verdict: string;
}

export interface PoolInfo {
  address: string;
  tokenMint: string;
  /** Тип пула Meteora: 'DLMM' | 'DAMM V2' | 'DAMM' | 'Meteora'. */
  poolType: string;
  feeBps: number;
  binStep: number;
  tvl: number;
  activeBinId: number;
  currentPrice: number;
}

export type PositionStatus = 'watching' | 'active' | 'closing' | 'closed';

export interface Position {
  id: number;
  tokenAddress: string;
  tokenSymbol: string;
  poolAddress: string;
  feeBps: number;
  binStep: number;
  entryPrice: number;
  solAmount: number;
  positionPubkey: string;
  status: PositionStatus;
  openedAt: number;
  closedAt: number | null;
  pnlSol: number | null;
}

export interface WatchedToken {
  id: number;
  tokenAddress: string;
  tokenSymbol: string;
  startedAt: number;
  status: 'watching' | 'found_pool' | 'entered' | 'timed_out' | 'cancelled';
}

export type ExitReason =
  | 'stop_loss'
  | 'bollinger_breakout'
  | 'new_ath'
  | 'fee_target'
  | 'chart_degradation'
  | 'panic_composite'
  | 'manual';

export interface ExitSignal {
  positionId: number;
  reason: ExitReason;
  details: string;
}
