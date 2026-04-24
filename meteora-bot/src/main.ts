import 'dotenv/config';
import fs from 'fs';
import { logger } from './shared/logger';
import { getDb } from './shared/db';
import { ScannerService } from './services/scanner';
import { SecurityChecker } from './services/security';
import { PoolWatcher } from './services/pool-watcher';
import { LpManager } from './services/lp-manager';
import { ExitStrategy } from './services/exit-strategy';
import { TelegramBot } from './bot';
import { TokenInfo, PoolInfo } from './shared/types';

// Ensure required directories exist
fs.mkdirSync('data', { recursive: true });
fs.mkdirSync('logs', { recursive: true });

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

  // ─── Wire up Scanner → Security → PoolWatcher ─────────────────────────────

  scanner.onToken(async (token: TokenInfo) => {
    logger.info(`Processing token: ${token.symbol} (${token.address})`);

    // Save to DB
    db.prepare(
      `INSERT OR IGNORE INTO tokens (address, symbol, name, market_cap, volume_24h, price_usd, ath)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(token.address, token.symbol, token.name, token.marketCap, token.volume24h, token.priceUsd, token.ath);

    // Security check
    const secResult = await security.check(token.address);

    // Update DB with security result
    db.prepare(
      `UPDATE tokens SET security_passed=?, security_warnings=? WHERE address=?`
    ).run(
      secResult.passed ? 1 : 0,
      JSON.stringify(secResult.warnings),
      token.address
    );

    // Notify Telegram
    await tgBot.notifyNewToken(token, secResult);

    if (!secResult.passed) {
      // If security failed, send inline button "Войти несмотря на предупреждения"
      await tgBot.sendMessage(
        `⚠️ Токен *${token.symbol}* не прошёл проверку безопасности\\.\n` +
          `Хотите всё равно наблюдать за пулом?`
      );
      // The force_enter callback is already set up in bot — it triggers manual pool watch
      return;
    }

    if (!lpManager.canOpenPosition()) {
      logger.info(`Max positions reached, skipping ${token.symbol}`);
      return;
    }

    // Start watching for pool
    db.prepare(
      `INSERT INTO watched_tokens (token_address, token_symbol, status) VALUES (?, ?, 'watching')`
    ).run(token.address, token.symbol);

    poolWatcher.watch(token.address, token.symbol);
  });

  // ─── Pool found → notify TG for confirmation ──────────────────────────────

  poolWatcher.onPoolFound(async (tokenAddress, pools, hasTargetFee) => {
    const token = await scanner.fetchTokenInfo(tokenAddress);
    if (!token) return;

    await tgBot.notifyPoolFound(token, pools, hasTargetFee);
  });

  poolWatcher.onTimeout(async (tokenAddress, tokenSymbol) => {
    db.prepare(
      `UPDATE watched_tokens SET status='timed_out' WHERE token_address=? AND status='watching'`
    ).run(tokenAddress);
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

    db.prepare(
      `UPDATE watched_tokens SET status='entered' WHERE token_address=? AND status='watching'`
    ).run(tokenAddress);

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
      const db2 = getDb();
      const row = db2
        .prepare(`SELECT token_symbol FROM watched_tokens WHERE token_address=? ORDER BY id DESC LIMIT 1`)
        .get(tokenAddress) as { token_symbol: string } | undefined;
      const symbol = row?.token_symbol ?? tokenAddress.slice(0, 8);
      poolWatcher.watch(tokenAddress, symbol);
    } else {
      db.prepare(
        `UPDATE watched_tokens SET status='cancelled' WHERE token_address=? AND status='watching'`
      ).run(tokenAddress);
    }
  };

  // ─── Manual exit ──────────────────────────────────────────────────────────

  tgBot.onExitPosition = async (positionId: number) => {
    exitStrategy.clearHistory(positionId);
    const result = await lpManager.closePosition(positionId);
    const db2 = getDb();
    const position = db2
      .prepare(`SELECT * FROM positions WHERE id=?`)
      .get(positionId) as any;
    if (result && position) {
      position.pnlSol = result.pnlSol;
      await tgBot.notifyPositionClosed(position, 'manual');
    } else {
      await tgBot.notifyError(`Не удалось закрыть позицию #${positionId}`);
    }
  };

  // ─── Exit Strategy signals ────────────────────────────────────────────────

  exitStrategy.onExit(async (signal) => {
    exitStrategy.clearHistory(signal.positionId);
    const result = await lpManager.closePosition(signal.positionId);
    const db2 = getDb();
    const position = db2
      .prepare(`SELECT * FROM positions WHERE id=?`)
      .get(signal.positionId) as any;
    if (result && position) {
      position.pnlSol = result.pnlSol;
      await tgBot.notifyPositionClosed(position, signal.reason);
    }
  });

  // ─── Start all services ───────────────────────────────────────────────────

  tgBot.start();
  scanner.start();
  exitStrategy.start();

  logger.info('All services started');
  await tgBot.sendMessage('🤖 *Meteora LP Bot запущен*');

  // Graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  function shutdown(): void {
    logger.info('Shutting down...');
    scanner.stop();
    exitStrategy.stop();
    tgBot.stop();
    process.exit(0);
  }
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
