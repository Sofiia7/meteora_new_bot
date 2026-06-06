import { BollingerBands, RSI } from 'technicalindicators';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { getDb } from '../../shared/db';
import { Position, ExitSignal } from '../../shared/types';
import { LpManager } from '../lp-manager';
import { ScannerService } from '../scanner';

type ExitCallback = (signal: ExitSignal) => void;

interface PriceHistory {
  prices: number[];
  ath: number;
}

export class ExitStrategy {
  private priceHistory = new Map<number, PriceHistory>();
  private intervalHandle: NodeJS.Timeout | null = null;
  private callbacks: ExitCallback[] = [];

  constructor(
    private lpManager: LpManager,
    private scanner: ScannerService
  ) {}

  onExit(cb: ExitCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    // Check every 60 seconds
    this.intervalHandle = setInterval(() => this.checkAll(), 60_000);
    logger.info('Exit strategy monitor started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private async checkAll(): Promise<void> {
    const db = getDb();
    // Колонки в БД snake_case, а Position — camelCase: явно алиасим,
    // иначе position.poolAddress/entryPrice будут undefined в рантайме.
    const positions = db
      .prepare(
        `SELECT id, token_address AS tokenAddress, token_symbol AS tokenSymbol,
                pool_address AS poolAddress, fee_bps AS feeBps, bin_step AS binStep,
                entry_price AS entryPrice, sol_amount AS solAmount,
                position_pubkey AS positionPubkey, status,
                opened_at AS openedAt, closed_at AS closedAt, pnl_sol AS pnlSol
         FROM positions WHERE status='active'`
      )
      .all() as Position[];

    for (const pos of positions) {
      await this.checkPosition(pos);
    }
  }

  private async checkPosition(position: Position): Promise<void> {
    try {
      const signal = await this.detectExitSignal(position);
      if (signal) {
        logger.info(`Exit signal for position ${position.id}: ${signal.reason}`);
        db_recordSignal(position.id, signal.reason, signal.details);
        for (const cb of this.callbacks) cb(signal);
      }
    } catch (err) {
      logger.error(`Exit check error for position ${position.id}: ${err}`);
    }
  }

  private async detectExitSignal(position: Position): Promise<ExitSignal | null> {
    // Текущая цена — нужна и для стоп-лосса, и для индикаторов ниже.
    const currentPrice = await this.lpManager.getCurrentPrice(position.poolAddress);

    // 0. Жёсткий стоп-лосс (страховка) — высший приоритет.
    //    Срабатывает на быстром сливе / руге / фаде, которые индикаторы не ловят.
    if (currentPrice !== null && position.entryPrice > 0) {
      const dropPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      if (dropPct <= -config.exit.stopLossPercent) {
        return {
          positionId: position.id,
          reason: 'stop_loss',
          details: `Стоп-лосс: ${dropPct.toFixed(1)}% от входа ($${currentPrice.toFixed(8)})`,
        };
      }
    }

    // 1. Fee target check
    const feeRatio = await this.lpManager.getClaimedFeesRatio(position);
    if (feeRatio >= config.exit.feeThreshold) {
      return {
        positionId: position.id,
        reason: 'fee_target',
        details: `Fees: ${(feeRatio * 100).toFixed(2)}% of position`,
      };
    }

    // 2. Для индикаторных проверок ниже нужна цена
    if (currentPrice === null) return null;

    // Update price history
    const history = this.getHistory(position.id);
    history.prices.push(currentPrice);
    if (currentPrice > history.ath) {
      history.ath = currentPrice;
    }
    // Keep last 50 candles
    if (history.prices.length > 50) history.prices.shift();

    // 3. New ATH check (>5% above previous ATH)
    const prevAth = history.ath;
    if (history.prices.length > 5 && currentPrice > prevAth * 1.05) {
      history.ath = currentPrice;
      return {
        positionId: position.id,
        reason: 'new_ath',
        details: `New ATH: $${currentPrice.toFixed(8)} (prev: $${prevAth.toFixed(8)})`,
      };
    }

    // Need at least period+1 data points for indicators
    if (history.prices.length < config.exit.bollingerPeriod + 1) return null;

    // 4. Bollinger Bands breakout
    const bbResult = BollingerBands.calculate({
      period: config.exit.bollingerPeriod,
      stdDev: config.exit.bollingerStdDev,
      values: history.prices,
    });

    if (bbResult.length > 0) {
      const lastBb = bbResult[bbResult.length - 1];
      if (currentPrice > lastBb.upper) {
        return {
          positionId: position.id,
          reason: 'bollinger_breakout',
          details: `Price $${currentPrice.toFixed(8)} > BB upper $${lastBb.upper.toFixed(8)}`,
        };
      }
    }

    // 5. Chart degradation: RSI + volume
    if (history.prices.length >= 14) {
      const rsiResult = RSI.calculate({ period: 14, values: history.prices });
      const lastRsi = rsiResult[rsiResult.length - 1];

      if (lastRsi && lastRsi < config.exit.rsiDegradationThreshold) {
        // Check volume degradation via DexScreener
        const tokenInfo = await this.scanner.fetchTokenInfo(position.tokenAddress);
        if (tokenInfo) {
          const volumeOk = tokenInfo.volume24h >= config.scanner.minVolume24h * config.exit.volumeDegradationRatio;
          if (!volumeOk) {
            return {
              positionId: position.id,
              reason: 'chart_degradation',
              details: `RSI: ${lastRsi.toFixed(1)}, Vol24h: $${tokenInfo.volume24h.toFixed(0)}`,
            };
          }
        }
      }
    }

    return null;
  }

  private getHistory(positionId: number): PriceHistory {
    if (!this.priceHistory.has(positionId)) {
      this.priceHistory.set(positionId, { prices: [], ath: 0 });
    }
    return this.priceHistory.get(positionId)!;
  }

  clearHistory(positionId: number): void {
    this.priceHistory.delete(positionId);
  }
}

function db_recordSignal(positionId: number, reason: string, details: string): void {
  const db = getDb();
  db.prepare(`INSERT INTO signals (position_id, reason, details) VALUES (?, ?, ?)`)
    .run(positionId, reason, details);
}
