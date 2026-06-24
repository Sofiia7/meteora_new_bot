import { RSI } from 'technicalindicators';
import { config } from '../../shared/config';
import { isNewAth, isFeeTarget, bollingerUpper } from './signals';
import { logger } from '../../shared/logger';
import { Positions, PriceHistoryRepo, recordSignal } from '../../shared/repositories';
import { Position, ExitSignal } from '../../shared/types';
import { LpManager } from '../lp-manager';
import { ScannerService } from '../scanner';

type ExitCallback = (signal: ExitSignal) => void;

export interface DegradationWarning {
  positionId: number;
  tokenSymbol: string;
  tokenAddress: string;
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
  /** Был ли уже подтянут из БД lazy-load'ом. */
  loaded: boolean;
}

const MAX_HISTORY = 50;

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
    if (isFeeTarget(feeRatio, config.exit.feeThreshold)) {
      return {
        positionId: position.id,
        reason: 'fee_target',
        details: `Fees: ${(feeRatio * 100).toFixed(2)}% of position`,
      };
    }

    if (currentPrice === null) return null;

    const history = this.getHistory(position.id);
    history.prices.push(currentPrice);
    if (history.prices.length > MAX_HISTORY) history.prices.shift();

    // Персистим точку в БД (recovery после рестарта).
    PriceHistoryRepo.insert(position.id, currentPrice);
    // Раз в N тиков чистим старые записи, чтобы таблица не пухла.
    if (history.prices.length % 25 === 0) {
      PriceHistoryRepo.pruneOlder(position.id, MAX_HISTORY);
    }

    // 2. New ATH — авто-выход (тейк-профит).
    //    Раньше код бампил history.ath ДО сравнения → условие никогда не срабатывало.
    //    Сейчас: сравниваем с lastSignalledAth (или ath, если ещё не сигналили).
    const referenceAth = history.lastSignalledAth || history.ath;
    if (isNewAth(currentPrice, referenceAth, history.prices.length)) {
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
    const upper = bollingerUpper(
      history.prices,
      config.exit.bollingerPeriod,
      config.exit.bollingerStdDev
    );
    if (upper !== null && currentPrice > upper) {
      return {
        positionId: position.id,
        reason: 'bollinger_breakout',
        details: `Price $${currentPrice.toFixed(8)} > BB upper $${upper.toFixed(8)}`,
      };
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
                tokenAddress: position.tokenAddress,
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
      // Lazy-load: при первом обращении (особенно после рестарта бота)
      // подтягиваем последние N цен из БД, чтобы BB/RSI/ATH не начинали
      // считать «с нуля» и слепо ждать period+1 минут до восстановления.
      const persisted = PriceHistoryRepo.latestN(positionId, MAX_HISTORY);
      const ath = persisted.reduce((m, p) => (p > m ? p : m), 0);
      h = { prices: persisted, ath, lastSignalledAth: ath, loaded: true };
      this.priceHistory.set(positionId, h);
      if (persisted.length > 0) {
        logger.info(
          `Position ${positionId}: restored ${persisted.length} price points from DB, ATH=${ath}`
        );
      }
    }
    return h;
  }

  clearHistory(positionId: number): void {
    this.priceHistory.delete(positionId);
    PriceHistoryRepo.deleteByPosition(positionId);
  }
}
