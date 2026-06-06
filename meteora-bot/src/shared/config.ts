import * as dotenv from 'dotenv';
import path from 'path';
import bs58 from 'bs58';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env variable: ${key}`);
  return value;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

function numEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  if (Number.isNaN(n)) throw new Error(`Invalid number in env ${key}: ${v}`);
  return n;
}

function intEnv(key: string, fallback: number): number {
  return Math.trunc(numEnv(key, fallback));
}

function listEnv(key: string): string[] {
  const v = process.env[key];
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Валидируем приватник ДО запуска: лучше упасть на старте, чем при первой транзакции.
const privateKey = requireEnv('SOLANA_PRIVATE_KEY');
try {
  const decoded = bs58.decode(privateKey);
  if (decoded.length !== 64) {
    throw new Error(`expected 64 bytes, got ${decoded.length}`);
  }
} catch (err) {
  throw new Error(`SOLANA_PRIVATE_KEY invalid (base58, 64 bytes expected): ${err}`);
}

const allowedChatIds = listEnv('TELEGRAM_ALLOWED_CHAT_IDS');
const telegramChatId = requireEnv('TELEGRAM_CHAT_ID');
// Если allowlist пуст — единственный доверенный chat = TELEGRAM_CHAT_ID.
const effectiveAllowlist = allowedChatIds.length > 0 ? allowedChatIds : [telegramChatId];

export const config = {
  safety: {
    dryRun: boolEnv('DRY_RUN', true),
    enableMainnetTrading: boolEnv('ENABLE_MAINNET_TRADING', false),
  },
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    chatId: telegramChatId,
    allowedChatIds: effectiveAllowlist,
  },
  solana: {
    privateKey,
    rpcUrl: requireEnv('RPC_URL'),
    rpcWsUrl: process.env['RPC_WS_URL'] ?? '',
  },
  lp: {
    amountSol: numEnv('LP_AMOUNT_SOL', 0.1),
    maxPositions: intEnv('MAX_POSITIONS', 3),
    priceRangeLower: numEnv('PRICE_RANGE_LOWER', -90),
    priceRangeUpper: numEnv('PRICE_RANGE_UPPER', 100),
    swapSlippageBps: intEnv('SWAP_SLIPPAGE_BPS', 100),
    safetyBufferSol: numEnv('WALLET_SAFETY_BUFFER_SOL', 0.1),
    safetyBufferPct: numEnv('WALLET_SAFETY_BUFFER_PCT', 15),
  },
  scanner: {
    intervalMs: intEnv('SCANNER_INTERVAL_MS', 300000),
    minMarketCap: intEnv('MIN_MARKET_CAP', 250000),
    minVolume24h: intEnv('MIN_VOLUME_24H', 1000000),
  },
  poolWatcher: {
    checkIntervalMs: intEnv('POOL_CHECK_INTERVAL_MS', 30000),
    watchTimeoutMs: intEnv('POOL_WATCH_TIMEOUT_MS', 7200000),
    targetFeeBps: 500,
    preferredBinSteps: [80, 100, 125],
  },
  security: {
    minGmgnFeesSol: numEnv('MIN_GMGN_FEES_SOL', 30),
  },
  exit: {
    // Solo-сигналы → авто-выход (тейк-профиты).
    feeThreshold: numEnv('EXIT_FEE_THRESHOLD', 0.05),
    bollingerPeriod: intEnv('BOLLINGER_PERIOD', 20),
    bollingerStdDev: numEnv('BOLLINGER_STD_DEV', 2),

    // Деградация графика → ТОЛЬКО предупреждение, не авто-выход.
    rsiDegradationThreshold: numEnv('RSI_DEGRADATION_THRESHOLD', 40),
    volumeDegradationRatio: numEnv('VOLUME_DEGRADATION_RATIO', 0.3),

    // Ценовой стоп-лосс — выключен по умолчанию (решение заказчика).
    enablePriceStopLoss: boolEnv('ENABLE_PRICE_STOP_LOSS', false),
    stopLossPercent: numEnv('EXIT_STOP_LOSS_PERCENT', 35),
  },
  panic: {
    // Composite-детектор: авто-выход при N факторах одновременно в окне.
    requiredFactors: intEnv('PANIC_REQUIRED_FACTORS', 2),
    timeWindowMin: intEnv('PANIC_TIME_WINDOW_MIN', 15),
    volumeDropPct: numEnv('PANIC_VOLUME_DROP_PCT', 60),
    rsiThreshold: numEnv('PANIC_RSI_THRESHOLD', 40),
    priceDropFromAthPct: numEnv('PANIC_PRICE_DROP_FROM_ATH_PCT', 50),
    tvlDropPct: numEnv('PANIC_TVL_DROP_PCT', 50),
  },
  athRenotify: {
    pct: numEnv('ATH_RENOTIFY_PCT', 10),
    cooldownMin: intEnv('ATH_RENOTIFY_COOLDOWN_MIN', 30),
  },
  chartHealth: {
    minScore: intEnv('MIN_HEALTH_SCORE', 65),
    maxAthDistancePct: numEnv('MAX_ATH_DISTANCE_PCT', 30),
  },
  redis: {
    url: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  },
};

export function isMainnetTradingEnabled(): boolean {
  return !config.safety.dryRun && config.safety.enableMainnetTrading;
}
