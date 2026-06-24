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
import { ChartHealthAnalyzer } from './services/chart-health';
import { AthWatcher } from './services/ath-watcher';
import { AiAnalyst } from './services/ai-analyst';
import { TelegramBot } from './bot';
import { TokenInfo, PoolInfo } from './shared/types';

// Ensure required directories exist
fs.mkdirSync('data', { recursive: true });
fs.mkdirSync('logs', { recursive: true });

/** Экранирование для немногих HTML-сообщений, что main.ts шлёт напрямую. */
function escHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function printStartupBanner(walletAddress: string): void {
  const mode = isMainnetTradingEnabled() ? '🔴 MAINNET TRADING' : '🟡 DRY_RUN (no real tx)';
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

  // Initialize services. getDb() вызываем ради побочного эффекта — инициализации
  // схемы БД; сами SQL-запросы идут через репозитории.
  getDb();
  const scanner = new ScannerService();
  const security = new SecurityChecker();
  const poolWatcher = new PoolWatcher();
  const lpManager = new LpManager();
  const tgBot = new TelegramBot();
  const exitStrategy = new ExitStrategy(lpManager, scanner);
  const panicDetector = new PanicDetector(scanner, exitStrategy, security);
  const chartHealth = new ChartHealthAnalyzer();
  const athWatcher = new AthWatcher(scanner);
  const aiAnalyst = new AiAnalyst();

  printStartupBanner(lpManager.getWalletAddress());

  // ─── Wire up Scanner → Security → PoolWatcher ─────────────────────────────

  /**
   * Главный пайплайн обработки токена. Используется и сканером (первое
   * обнаружение), и AthWatcher'ом (re-notify по новому ATH +X%).
   */
  const processToken = async (token: TokenInfo, prefix = ''): Promise<void> => {
    logger.info(`${prefix}Processing token: ${token.symbol} (${token.address})`);
    Tokens.upsert(token);

    // 1. Chart-health (ТЗ 1.2).
    const health = chartHealth.analyze(token);
    if (!health.passes) {
      logger.info(
        `${token.symbol} health score ${health.score}/100 < min ${health.score}, skip. ` +
          `Reasons: ${health.reasons.join('; ')}`
      );
      return;
    }

    // 2. Security re-check (полный — даже при re-notify, ловим отложенный руг).
    const secResult = await security.check(token.address);
    Tokens.setSecurity(token.address, secResult.passed, secResult.warnings);

    const aiVerdict = await aiAnalyst.analyzeToken(token, secResult);
    await tgBot.notifyNewToken(token, secResult, aiVerdict ?? undefined);

    if (!secResult.passed) {
      await tgBot.sendMessage(
        `⚠️ Токен <b>${escHtml(token.symbol)}</b> не прошёл проверку безопасности.\n` +
          `Чтобы всё равно отслеживать пул — ответьте: <code>/scan force:${escHtml(token.address)}</code>`
      );
      return;
    }

    if (!lpManager.canOpenPosition()) {
      logger.info(`Max positions reached, skipping ${token.symbol}`);
      return;
    }

    WatchedTokens.insertWatching(token.address, token.symbol);
    poolWatcher.watch(token.address, token.symbol);
  };

  scanner.onToken((token) => void processToken(token));

  // Re-notification по новому ATH (+ATH_RENOTIFY_PCT% над прошлым уведомлением).
  // Полный перепрогон пайплайна — chart-health + security заново.
  athWatcher.onRenotify(async (token, newAth, prevAth) => {
    await tgBot.notifyAthRenotify(token, newAth, prevAth);
    await processToken(token, '[ATH re-notify] ');
  });

  // ─── Pool found → notify TG for confirmation ──────────────────────────────

  poolWatcher.onPoolFound(async (tokenAddress, pools) => {
    let token = await scanner.fetchTokenInfo(tokenAddress);
    if (!token) {
      // fetchTokenInfo может null'нуть из-за рейтлимита / кэша / 5xx —
      // раньше при этом пул терялся молча. Сейчас минимальный «синтетический»
      // токен, чтобы пользователь хотя бы получил уведомление с CA.
      const symbol = WatchedTokens.latestSymbol(tokenAddress) ?? tokenAddress.slice(0, 8);
      token = {
        address: tokenAddress,
        symbol,
        name: symbol,
        marketCap: 0,
        volume24h: 0,
        priceUsd: 0,
        priceChange24h: 0,
        ath: 0,
        athDate: '',
        liquidity: 0,
        pairAddress: '',
        dexId: '',
        chainId: 'solana',
        createdAt: 0,
      };
      logger.warn(`Pool found but token info unavailable — notifying with stub for ${tokenAddress}`);
    }

    await tgBot.notifyPoolFound(token, pools);
  });

  poolWatcher.onTimeout(async (tokenAddress, tokenSymbol) => {
    WatchedTokens.setStatus(tokenAddress, 'watching', 'timed_out');
    await tgBot.notifyPoolTimeout(tokenAddress, tokenSymbol);
  });

  // ─── Ватчлист: «не входить» / убрать вручную / добавить вручную ───────────
  //
  // stopWatching живёт на poolWatcher (этот скоуп), поэтому отмену делаем здесь,
  // а не в боте. cancel() переводит все незавершённые строки токена в cancelled.
  tgBot.onCancelWatch = (tokenAddress: string) => {
    poolWatcher.stopWatching(tokenAddress);
    WatchedTokens.cancel(tokenAddress);
  };

  tgBot.onAddWatch = async (ca: string) => {
    const token = await scanner.scanToken(ca);
    if (!token) {
      await tgBot.notifyError(`Токен ${ca} не найден`);
      return;
    }
    WatchedTokens.insertWatching(token.address, token.symbol);
    poolWatcher.watch(token.address, token.symbol);
  };

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
    const aiVerdict = await aiAnalyst.analyzeToken(token, secResult);
    await tgBot.notifyNewToken(token, secResult, aiVerdict ?? undefined);

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
    await tgBot.notifyDegradation(w.positionId, w.tokenSymbol, w.message, w.tokenAddress);
  });

  // ─── Start all services ───────────────────────────────────────────────────

  // ─── Recovery после рестарта ──────────────────────────────────────────────
  //
  // Активные позиции подхватятся автоматически в первом же тике exit-strategy
  // и panic-detector (они читают Positions.findActive()). priceHistory тоже
  // lazy-восстанавливается из БД при первом обращении (Phase 2).
  //
  // Здесь нужно вручную «оживить» watched_tokens(watching) — иначе пользователь
  // потеряет токены, которые бот ждал на момент падения.
  const watchingRows = WatchedTokens.findWatching();
  if (watchingRows.length > 0) {
    logger.info(`Recovery: restoring ${watchingRows.length} watched tokens`);
    for (const w of watchingRows) {
      poolWatcher.watch(w.tokenAddress, w.tokenSymbol);
    }
  }
  const activePositions = Positions.findActive();
  if (activePositions.length > 0) {
    logger.info(
      `Recovery: ${activePositions.length} active positions will be picked up by monitors`
    );
  }

  tgBot.start();
  scanner.start();
  exitStrategy.start();
  panicDetector.start();
  athWatcher.start();

  logger.info('All services started');
  const modeLabel = isMainnetTradingEnabled() ? '🔴 MAINNET' : '🟡 DRY_RUN';
  const recoveryLines: string[] = [];
  if (watchingRows.length > 0) {
    recoveryLines.push(`♻️ Восстановлено наблюдений: ${watchingRows.length}`);
  }
  if (activePositions.length > 0) {
    recoveryLines.push(`♻️ Активных позиций: ${activePositions.length}`);
  }
  await tgBot.sendMessage(
    `🤖 <b>Meteora LP Bot запущен</b> — ${modeLabel}\n` +
      `Кошелёк: <code>${escHtml(lpManager.getWalletAddress())}</code>` +
      (recoveryLines.length ? `\n${recoveryLines.join('\n')}` : '')
  );

  // Graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  function shutdown(): void {
    logger.info('Shutting down...');
    scanner.stop();
    exitStrategy.stop();
    panicDetector.stop();
    athWatcher.stop();
    tgBot.stop();
    process.exit(0);
  }
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
