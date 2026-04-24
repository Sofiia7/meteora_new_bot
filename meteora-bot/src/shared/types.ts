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
  gmgnFeesSol: number;
  rugcheckStatus: string;
  holderConcentration: number;
  twitterActive: boolean;
  warnings: string[];
}

export interface PoolInfo {
  address: string;
  tokenMint: string;
  feeBps: number;
  binStep: number;
  tvl: number;
  activeBinId: number;
  currentPrice: number;
}

export type PositionStatus = 'watching' | 'active' | 'closed';

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

export type ExitReason = 'bollinger_breakout' | 'new_ath' | 'fee_target' | 'chart_degradation' | 'manual';

export interface ExitSignal {
  positionId: number;
  reason: ExitReason;
  details: string;
}
