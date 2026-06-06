import 'dotenv/config';
import fs from 'fs';
import { logger } from './shared/logger';
import { config, isMainnetTradingEnabled } from './shared/config';
import { getDb } from './shared/db';
import { Positions, Tokens, WatchedTokens } from './shared/repositories';
// getDb() здесь нужен только для побочного эффекта — init схемы.
// Сами SQL-запросы идут через репозитории.
import { ScannerService } from './services/scanner';
import { SecurityChecker } from './services/security';
import { PoolWatcher } from './services/pool-watcher';
import { LpManager } from './services/lp-manager';
import { ExitStrategy } from './services/exit-strategy';
import { PanicDetector } from './services/panic-detector';
import { TelegramBot } from './bot';
import { TokenInfo, PoolInfo } from './shared/types';

// Ensure required directories exist
fs.mkdirSync('data', { recursive: true });
fs.mkdirSync('logs', { recursive: true });

function printStartupBanner(walletAddress: string): void {
  const mode = isMainnetTradingEnabled() ? '🔴 MAINNET TRADING' : '🟡 DRY_RUN (no real tx)';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dlmmVersion = (() => {
    try {
      return require('@meteora-ag/dlmm/package.json').version as string;
    } catch {
      return 'unknown';
    }
  })();
  const lines = [
    '╔═══════════════════════════════════════════════════════════',
    '║  Meteora LP Bot',
    `║  Mode:           ${mode}`,
    `║  Wallet:         ${walletAddress}`,
    `║  Allowed chats:  ${config.telegram.allowedChatIds.join(', ')}`,
    `║  Max positions:  ${config.lp.maxPositions}`,
    `║  LP per pos:     ${config.lp.amountSol} SOL`,
    `║  Panic factors:  ${config.panic.requiredFactors} of M in ${config.panic.timeWindowMin}m`,
    `║  ATH re-notify:  +${config.athRenotify.pct}% (cooldown ${config.athRenotify.cooldownMin}m)`,
    `║  @meteora-ag/dlmm: ${dlmmVersion}`,
    '╚═══════════════════════════════════════════════════════════',
  ];
  for (const l of lines) logger.info(l);
}

async function main(): Promise<void> {
  logger.info('=== Meteora LP Bot starting ===');

  // Initialize services
  const db = getDb();
  const scanner = new ScannerService();
  const security = new SecurityChecker();
  const poolWatcher = new PoolWatcher();
  const lpManager = new LpManager();
  const tgBot = new TelegramBot();
  const exitStrategy = new ExitStrategy(lpManager, scanner);
  const panicDetector = new PanicDetector(lpManager, scanner, exitStrategy);

  printStartupBanner(lpManager.getWalletAddress());

  // ─── Wire up Scanner → Security → PoolWatcher ─────────────────────────────

  scanner.onToken(async (token: TokenInfo) => {
    logger.info(`Processing token: ${token.symbol} (${token.address})`);

    Tokens.upsert(token);

    const secResult = await security.check(token.address);
    Tokens.setSecurity(token.address, secResult.passed, secResult.warnings);

    await tgBot.notifyNewToken(token, secResult);

    if (!secResult.passed) {
      // Telegram-кнопка force_enter подключается в Фазе 5; пока — текстовое
      // приглашение, пользователь может ответить /scan force:<CA>.
      await tgBot.sendMessage(
        `⚠️ Токен *${token.symbol}* не прошёл проверку безопасности\\.\n` +
          `Чтобы всё равно отслеживать пул — ответьте: \`/scan force:${token.address}\``
      );
      return;
    }

    if (!lpManager.canOpenPosition()) {
      logger.info(`Max positions reached, skipping ${token.symbol}`);
      return;
    }

    WatchedTokens.insertWatching(token.address, token.symbol);
    poolWatcher.watch(token.address, token.symbol);
  });

  // ─── Pool found → notify TG for confirmation ──────────────────────────────

  poolWatcher.onPoolFound(async (tokenAddress, pools, hasTargetFee) => {
    const token = await scanner.fetchTokenInfo(tokenAddress);
    if (!token) return;

    await tgBot.notifyPoolFound(token, pools, hasTargetFee);
  });

  poolWatcher.onTimeout(async (tokenAddress, tokenSymbol) => {
    WatchedTokens.setStatus(tokenAddress, 'watching', 'timed_out');
    await tgBot.notifyPoolTimeout(tokenAddress, tokenSymbol);
  });

  // ─── User confirms pool entry ──────────────────────────────────────────────

  tgBot.onEnterPool = async (tokenAddress: string, pool: PoolInfo) => {
    const token = await scanner.fetchTokenInfo(tokenAddress);
    const symbol = token?.symbol ?? tokenAddress.slice(0, 8);

    if (!lpManager.canOpenPosition()) {
      await tgBot.notifyError(`Достигнут лимит позиций (${lpManager.getActivePositionCount()}). Сначала закройте одну из них.`);
      return;
    }

    poolWatcher.stopWatching(tokenAddress);
    WatchedTokens.setStatus(tokenAddress, 'watching', 'entered');

    const position = await lpManager.openPosition(tokenAddress, symbol, pool);
    if (position) {
      await tgBot.notifyPositionOpened(position);
    } else {
      await tgBot.notifyError(`Не удалось открыть позицию для ${symbol}`);
    }
  };

  // ─── User manual scan ─────────────────────────────────────────────────────

  tgBot.onManualScan = async (address: string) => {
    const forced = address.startsWith('force:');
    const tokenAddress = forced ? address.slice(6) : address;

    const token = await scanner.scanToken(tokenAddress);
    if (!token) {
      await tgBot.notifyError(`Токен ${tokenAddress} не найден`);
      return;
    }

    if (forced) {
      // Skip security, go straight to pool watching
      poolWatcher.watch(token.address, token.symbol);
      return;
    }

    const secResult = await security.check(token.address);
    await tgBot.notifyNewToken(token, secResult);

    if (!secResult.passed) {
      // Notify with force-enter button
      await tgBot.sendMessage(
        `⚠️ *${token.symbol}* не прошёл безопасность\\. Предупреждения:\n` +
          secResult.warnings.map((w) => `• ${w}`).join('\n') +
          `\n\nВсё равно отслеживать пул?`
      );
      // Inline button is handled via force_enter callback in bot
      return;
    }

    if (!lpManager.canOpenPosition()) {
      await tgBot.notifyError(`Достигнут лимит позиций`);
      return;
    }

    poolWatcher.watch(token.address, token.symbol);
  };

  // ─── Continue watching after timeout ──────────────────────────────────────

  tgBot.onContinueWatching = (tokenAddress, continueWatching) => {
    if (continueWatching) {
      const symbol = WatchedTokens.latestSymbol(tokenAddress) ?? tokenAddress.slice(0, 8);
      poolWatcher.watch(tokenAddress, symbol);
    } else {
      WatchedTokens.setStatus(tokenAddress, 'watching', 'cancelled');
    }
  };

  // ─── Manual exit ──────────────────────────────────────────────────────────

  tgBot.onExitPosition = async (positionId: number) => {
    exitStrategy.clearHistory(positionId);
    const result = await lpManager.closePosition(positionId);
    const position = Positions.findById(positionId);
    if (result && position) {
      position.pnlSol = result.pnlSol;
      await tgBot.notifyPositionClosed(position, 'manual');
    } else {
      await tgBot.notifyError(`Не удалось закрыть позицию #${positionId}`);
    }
  };

  // ─── Exit Strategy / Panic Detector signals (общая шина) ──────────────────

  const handleAutoExit = async (signal: import('./shared/types').ExitSignal): Promise<void> => {
    exitStrategy.clearHistory(signal.positionId);
    panicDetector.clearState(signal.positionId);
    const result = await lpManager.closePosition(signal.positionId);
    const position = Positions.findById(signal.positionId);
    if (result && position) {
      position.pnlSol = result.pnlSol;
      await tgBot.notifyPositionClosed(position, signal.reason);
    }
  };

  exitStrategy.onExit(handleAutoExit);
  panicDetector.onExit(handleAutoExit);

  // Деградация графика — НЕ авто-выход, а предупреждение с кнопкой.
  exitStrategy.onDegradationWarning(async (w) => {
    await tgBot.notifyDegradation(w.positionId, w.tokenSymbol, w.message);
  });

  // ─── Start all services ───────────────────────────────────────────────────

  tgBot.start();
  scanner.start();
  exitStrategy.start();
  panicDetector.start();

  logger.info('All services started');
  const modeLabel = isMainnetTradingEnabled() ? '🔴 MAINNET' : '🟡 DRY\\_RUN';
  await tgBot.sendMessage(
    `🤖 *Meteora LP Bot запущен* — ${modeLabel}\n` +
      `Кошелёк: \`${lpManager.getWalletAddress()}\``
  );

  // Graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  function shutdown(): void {
    logger.info('Shutting down...');
    scanner.stop();
    exitStrategy.stop();
    panicDetector.stop();
    tgBot.stop();
    process.exit(0);
  }
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
