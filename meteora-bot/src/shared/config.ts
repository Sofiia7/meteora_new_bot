import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env variable: ${key}`);
  return value;
}

export const config = {
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    chatId: requireEnv('TELEGRAM_CHAT_ID'),
  },
  solana: {
    privateKey: requireEnv('SOLANA_PRIVATE_KEY'),
    rpcUrl: requireEnv('RPC_URL'),
  },
  lp: {
    amountSol: parseFloat(process.env['LP_AMOUNT_SOL'] ?? '0.1'),
    maxPositions: parseInt(process.env['MAX_POSITIONS'] ?? '3', 10),
    priceRangeLower: parseFloat(process.env['PRICE_RANGE_LOWER'] ?? '-90'),
    priceRangeUpper: parseFloat(process.env['PRICE_RANGE_UPPER'] ?? '100'),
    swapSlippageBps: parseInt(process.env['SWAP_SLIPPAGE_BPS'] ?? '100', 10),
  },
  scanner: {
    intervalMs: parseInt(process.env['SCANNER_INTERVAL_MS'] ?? '300000', 10),
    minMarketCap: parseInt(process.env['MIN_MARKET_CAP'] ?? '250000', 10),
    minVolume24h: parseInt(process.env['MIN_VOLUME_24H'] ?? '1000000', 10),
  },
  poolWatcher: {
    checkIntervalMs: parseInt(process.env['POOL_CHECK_INTERVAL_MS'] ?? '30000', 10),
    watchTimeoutMs: parseInt(process.env['POOL_WATCH_TIMEOUT_MS'] ?? '7200000', 10),
    targetFeeBps: 500,
    preferredBinSteps: [80, 100, 125],
  },
  security: {
    minGmgnFeesSol: parseFloat(process.env['MIN_GMGN_FEES_SOL'] ?? '30'),
  },
  exit: {
    feeThreshold: parseFloat(process.env['EXIT_FEE_THRESHOLD'] ?? '0.05'),
    bollingerPeriod: parseInt(process.env['BOLLINGER_PERIOD'] ?? '20', 10),
    bollingerStdDev: parseFloat(process.env['BOLLINGER_STD_DEV'] ?? '2'),
    rsiDegradationThreshold: parseFloat(process.env['RSI_DEGRADATION_THRESHOLD'] ?? '40'),
    volumeDegradationRatio: parseFloat(process.env['VOLUME_DEGRADATION_RATIO'] ?? '0.3'),
  },
  redis: {
    url: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  },
};
