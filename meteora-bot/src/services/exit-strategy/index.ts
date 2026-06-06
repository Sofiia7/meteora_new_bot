import { BollingerBands, RSI } from 'technicalindicators';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { Positions, recordSignal } from '../../shared/repositories';
import { Position, ExitSignal } from '../../shared/types';
import { LpManager } from '../lp-manager';
import { ScannerService } from '../scanner';

type ExitCallback = (signal: ExitSignal) => void;

export interface DegradationWarning {
  positionId: number;
  tokenSymbol: string;
  rsi: number;
  volume24h: number;
  message: string;
}
type WarningCallback = (w: DegradationWarning) => void;

interface PriceHistory {
  prices: number[];
  ath: number;
  /** ATH, при котором мы в последний раз сигналили выход "new_ath". */
  lastSignalledAth: number;
}

/**
 * Exit monitor — отвечает за тейк-профиты:
 *   • BB-пробой (15м-эквивалент),
 *   • новый ATH ≥ +N% над прошлым signalled-ATH,
 *   • достижение целевой доли комиссий.
 *
 * Сценарий «полная картина пиздеца» (auto-panic) — это отдельный модуль
 * `panic-detector` (Фаза 1.5). Здесь авто-выхода по single-factor НЕТ.
 *
 * Деградация графика (RSI + объём) — только предупреждение через
 * `onDegradationWarning`, без авто-закрытия.
 *
 * Ценовой стоп-лосс — отключён по умолчанию (`ENABLE_PRICE_STOP_LOSS=false`).
 */
export class ExitStrategy {
  private priceHistory = new Map<number, PriceHistory>();
  private intervalHandle: NodeJS.Timeout | null = null;
  private exitCallbacks: ExitCallback[] = [];
  private warningCallbacks: WarningCallback[] = [];

  constructor(
    private lpManager: LpManager,
    private scanner: ScannerService
  ) {}

  onExit(cb: ExitCallback): void {
    this.exitCallbacks.push(cb);
  }

  onDegradationWarning(cb: WarningCallback): void {
    this.warningCallbacks.push(cb);
  }

  start(): void {
    this.intervalHandle = setInterval(() => this.checkAll(), 60_000);
    logger.info('Exit strategy monitor started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Доступ к истории цен для panic-detector (Фаза 1.5). */
  getPriceSnapshot(positionId: number): { prices: number[]; ath: number } | null {
    const h = this.priceHistory.get(positionId);
    return h ? { prices: [...h.prices], ath: h.ath } : null;
  }

  private async checkAll(): Promise<void> {
    const positions = Positions.findActive();
    for (const pos of positions) {
      await this.checkPosition(pos);
    }
  }

  private async checkPosition(position: Position): Promise<void> {
    try {
      const signal = await this.detectExitSignal(position);
      if (signal) {
        logger.info(`Exit signal for position ${position.id}: ${signal.reason}`);
        recordSignal(position.id, signal.reason, signal.details);
        for (const cb of this.exitCallbacks) cb(signal);
      }
    } catch (err) {
      logger.error(`Exit check error for position ${position.id}: ${err}`);
    }
  }

  private async detectExitSignal(position: Position): Promise<ExitSignal | null> {
    const currentPrice = await this.lpManager.getCurrentPrice(position.poolAddress);

    // 0. Ценовой стоп-лосс — отключён по умолчанию (решение заказчика:
    //    жёсткие SL дают слишком много ложных выбиваний на волатильности
    //    мемов; защита от руга — composite panic-detector + ручная кнопка).
    if (
      config.exit.enablePriceStopLoss &&
      currentPrice !== null &&
      position.entryPrice > 0
    ) {
      const dropPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      if (dropPct <= -config.exit.stopLossPercent) {
        return {
          positionId: position.id,
          reason: 'stop_loss',
          details: `Стоп-лосс: ${dropPct.toFixed(1)}% от входа ($${currentPrice.toFixed(8)})`,
        };
      }
    }

    // 1. Fee target — авто-выход (тейк-профит).
    const feeRatio = await this.lpManager.getFeesRatio(position);
    if (feeRatio >= config.exit.feeThreshold) {
      return {
        positionId: position.id,
        reason: 'fee_target',
        details: `Fees: ${(feeRatio * 100).toFixed(2)}% of position`,
      };
    }

    if (currentPrice === null) return null;

    const history = this.getHistory(position.id);
    history.prices.push(currentPrice);
    if (history.prices.length > 50) history.prices.shift();

    // 2. New ATH — авто-выход (тейк-профит).
    //    Раньше код бампил history.ath ДО сравнения → условие никогда не срабатывало.
    //    Сейчас: сравниваем с lastSignalledAth (или ath, если ещё не сигналили).
    const referenceAth = history.lastSignalledAth || history.ath;
    if (
      history.prices.length > 5 &&
      referenceAth > 0 &&
      currentPrice > referenceAth * 1.05
    ) {
      history.ath = currentPrice;
      history.lastSignalledAth = currentPrice;
      return {
        positionId: position.id,
        reason: 'new_ath',
        details: `New ATH: $${currentPrice.toFixed(8)} (prev: $${referenceAth.toFixed(8)})`,
      };
    }
    // Бамп ATH ПОСЛЕ проверки.
    if (currentPrice > history.ath) history.ath = currentPrice;

    if (history.prices.length < config.exit.bollingerPeriod + 1) return null;

    // 3. Bollinger Bands breakout — авто-выход (тейк-профит).
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

    // 4. Деградация графика → ПРЕДУПРЕЖДЕНИЕ, не авто-выход.
    //    (Решение заказчика: одна деградация — не повод выходить; авто-выход
    //    случится, только если composite panic-detector соберёт ≥ N факторов.)
    if (history.prices.length >= 14) {
      const rsiResult = RSI.calculate({ period: 14, values: history.prices });
      const lastRsi = rsiResult[rsiResult.length - 1];
      if (lastRsi && lastRsi < config.exit.rsiDegradationThreshold) {
        const tokenInfo = await this.scanner.fetchTokenInfo(position.tokenAddress);
        if (tokenInfo) {
          const volOk =
            tokenInfo.volume24h >=
            config.scanner.minVolume24h * config.exit.volumeDegradationRatio;
          if (!volOk) {
            for (const cb of this.warningCallbacks) {
              cb({
                positionId: position.id,
                tokenSymbol: position.tokenSymbol,
                rsi: lastRsi,
                volume24h: tokenInfo.volume24h,
                message:
                  `RSI ${lastRsi.toFixed(1)} ниже ${config.exit.rsiDegradationThreshold}, ` +
                  `Vol24h $${tokenInfo.volume24h.toFixed(0)} ниже порога`,
              });
            }
          }
        }
      }
    }

    return null;
  }

  private getHistory(positionId: number): PriceHistory {
    let h = this.priceHistory.get(positionId);
    if (!h) {
      h = { prices: [], ath: 0, lastSignalledAth: 0 };
      this.priceHistory.set(positionId, h);
    }
    return h;
  }

  clearHistory(positionId: number): void {
    this.priceHistory.delete(positionId);
  }
}
