import { RSI } from 'technicalindicators';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { Positions, recordSignal } from '../../shared/repositories';
import { ExitSignal, Position } from '../../shared/types';
import { LpManager } from '../lp-manager';
import { ScannerService } from '../scanner';
import { ExitStrategy } from '../exit-strategy';

type ExitCallback = (signal: ExitSignal) => void;

/**
 * Composite panic-detector — «полная картина пиздеца».
 *
 * Решение заказчика: жёсткого одиночного стоп-лосса нет. Авто-выход срабатывает,
 * только когда одновременно (внутри окна `PANIC_TIME_WINDOW_MIN`) активны
 * ≥ `PANIC_REQUIRED_FACTORS` независимых негативных факторов:
 *
 *   F1 (volume_drop):   24h-объём токена сильно ниже порога сканера.
 *                       Точная "падение от 4ч-среднего" приедет в Фазе 3 (OHLCV).
 *   F2 (rsi_low):       RSI(14) текущей истории цен ниже PANIC_RSI_THRESHOLD.
 *   F3 (price_from_ath): просадка от ATH-в-позиции ≥ PANIC_PRICE_DROP_FROM_ATH_PCT.
 *   F4 (security_*):    Фаза 4 — security re-check показал ухудшение.
 *   F5 (tvl_drop):      Фаза 4 — TVL пула резко упал.
 *
 * Каждый раз, когда фактор активен, мы помечаем текущее время как момент его
 * последнего «срабатывания». Считаем активными те факторы, последний таймстамп
 * которых ≥ now − window.
 */

type FactorName = 'volume_drop' | 'rsi_low' | 'price_from_ath';

interface FactorState {
  lastActiveAt: number; // ms timestamp
}

interface PositionState {
  factors: Map<FactorName, FactorState>;
}

export class PanicDetector {
  private state = new Map<number, PositionState>();
  private intervalHandle: NodeJS.Timeout | null = null;
  private callbacks: ExitCallback[] = [];

  constructor(
    private lpManager: LpManager,
    private scanner: ScannerService,
    private exitStrategy: ExitStrategy
  ) {}

  onExit(cb: ExitCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    // 30 секунд — быстрее, чем 1-минутный exit-monitor: руг происходит за секунды,
    // а нам нужно несколько тиков, чтобы зафиксировать факторы в окне.
    this.intervalHandle = setInterval(() => this.checkAll(), 30_000);
    logger.info('Panic detector started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  clearState(positionId: number): void {
    this.state.delete(positionId);
  }

  private async checkAll(): Promise<void> {
    const positions = Positions.findActive();
    for (const pos of positions) {
      await this.checkPosition(pos);
    }
  }

  private async checkPosition(position: Position): Promise<void> {
    try {
      await this.evaluate(position);
      const active = this.activeFactors(position.id);
      if (active.length >= config.panic.requiredFactors) {
        const reason: ExitSignal['reason'] = 'panic_composite';
        const details = `Активны ${active.length} факторов: ${active.join(', ')}`;
        logger.warn(`PANIC for position ${position.id} (${position.tokenSymbol}): ${details}`);
        recordSignal(position.id, reason, details);
        // Сбрасываем state, чтобы при ретрае не сразу повторно дёрнуть.
        this.clearState(position.id);
        const signal: ExitSignal = { positionId: position.id, reason, details };
        for (const cb of this.callbacks) cb(signal);
      }
    } catch (err) {
      logger.error(`Panic check error for position ${position.id}: ${err}`);
    }
  }

  /** Запускает все факторные проверки, обновляет lastActiveAt у тех, что активны. */
  private async evaluate(position: Position): Promise<void> {
    const now = Date.now();
    const set = (name: FactorName): void => {
      const ps = this.getOrCreate(position.id);
      ps.factors.set(name, { lastActiveAt: now });
    };

    // F1 volume_drop — Vol24h ниже (1 − dropPct%) от порога сканера.
    // (Прокси до Фазы 3: «упало по сравнению с тем, что мы считали «здоровым».)
    const tokenInfo = await this.scanner.fetchTokenInfo(position.tokenAddress);
    if (tokenInfo) {
      const cutoff = config.scanner.minVolume24h * (1 - config.panic.volumeDropPct / 100);
      if (tokenInfo.volume24h < cutoff) set('volume_drop');
    }

    // F2 rsi_low — используем историю цен из exit-strategy (тот же поллер).
    const snap = this.exitStrategy.getPriceSnapshot(position.id);
    if (snap && snap.prices.length >= 14) {
      const rsi = RSI.calculate({ period: 14, values: snap.prices });
      const last = rsi[rsi.length - 1];
      if (last !== undefined && last < config.panic.rsiThreshold) set('rsi_low');
    }

    // F3 price_from_ath — просадка от наблюдённого ATH в позиции.
    if (snap && snap.ath > 0) {
      const currentPrice = snap.prices[snap.prices.length - 1] ?? 0;
      if (currentPrice > 0) {
        const dropPct = ((snap.ath - currentPrice) / snap.ath) * 100;
        if (dropPct >= config.panic.priceDropFromAthPct) set('price_from_ath');
      }
    }

    // F4 / F5 — добавятся в Фазе 4 (security re-check, TVL-наблюдение).
  }

  private activeFactors(positionId: number): FactorName[] {
    const ps = this.state.get(positionId);
    if (!ps) return [];
    const cutoff = Date.now() - config.panic.timeWindowMin * 60_000;
    const active: FactorName[] = [];
    for (const [name, state] of ps.factors) {
      if (state.lastActiveAt >= cutoff) active.push(name);
    }
    return active;
  }

  private getOrCreate(positionId: number): PositionState {
    let ps = this.state.get(positionId);
    if (!ps) {
      ps = { factors: new Map() };
      this.state.set(positionId, ps);
    }
    return ps;
  }
}
