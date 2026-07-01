import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { getDb } from '../../shared/db';
import { Positions, TokenAthRepo } from '../../shared/repositories';
import { TokenInfo } from '../../shared/types';
import { ScannerService, passesScannerFilters } from '../scanner';

export type RenotifyCallback = (token: TokenInfo, newAth: number, prevNotifiedAth: number) => void;

interface Row {
  address: string;
  symbol: string;
}

/**
 * ATH watcher — повторно уведомляет о токене, когда цена обновляет ATH
 * минимум на ATH_RENOTIFY_PCT (% от прошлого уведомлённого ATH).
 *
 * Правила (решение заказчика):
 *  - Уведомляем, только если новый ATH выше last_notified_ath на N%.
 *  - НЕ уведомляем, если по токену есть открытая позиция (status active/watching/closing).
 *  - Соблюдаем cooldown ATH_RENOTIFY_COOLDOWN_MIN.
 *  - При срабатывании запускаем ПОЛНЫЙ перепрогон пайплайна (chart-health +
 *    security) — это происходит в callback'е в main.ts.
 *
 * Здесь watcher только детектит триггер и эмитит событие; принимать решение,
 * пропускать ли security, оставляем на главном пайплайне.
 */
export class AthWatcher {
  private intervalHandle: NodeJS.Timeout | null = null;
  private callbacks: RenotifyCallback[] = [];
  // Throttle опроса: не чаще раза в 5 минут на токен (DexScreener-friendly).
  private lastPolledAt = new Map<string, number>();

  constructor(private scanner: ScannerService) {}

  onRenotify(cb: RenotifyCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    // Тикаем раз в 2 минуты; внутри сами пропускаем токены, у которых недавно
    // был polled. Главный поллер метаданных — Scanner; AthWatcher работает
    // с уже известными токенами.
    this.intervalHandle = setInterval(() => void this.checkAll(), 120_000);
    logger.info('ATH watcher started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private async checkAll(): Promise<void> {
    try {
      // Берём все известные токены, прошедшие фильтр scanner'а в прошлом
      // (security_passed = 1). В Фазе 3 этого достаточно — если security
      // протух, перепрогон security_check сам отсечёт.
      const rows = getDb()
        .prepare(
          `SELECT address, symbol FROM tokens
           WHERE security_passed=1
           ORDER BY discovered_at DESC LIMIT 50`
        )
        .all() as Row[];

      // Адреса с открытыми/активно отслеживаемыми позициями исключаем — по этим
      // токенам у юзера уже идёт работа, повторно дёргать не нужно.
      const busy = new Set(
        Positions.findOpen().map((p) => p.tokenAddress)
      );

      for (const r of rows) {
        if (busy.has(r.address)) continue;
        if (this.shouldSkipPolling(r.address)) continue;
        this.lastPolledAt.set(r.address, Date.now());
        await this.checkOne(r.address);
      }
    } catch (err) {
      logger.error(`AthWatcher.checkAll error: ${err}`);
    }
  }

  private shouldSkipPolling(address: string): boolean {
    const last = this.lastPolledAt.get(address);
    if (!last) return false;
    return Date.now() - last < 5 * 60_000; // 5 минут
  }

  private async checkOne(address: string): Promise<void> {
    const token = await this.scanner.fetchTokenInfo(address);
    if (!token || token.priceUsd <= 0) return;
    // Токен мог пройти security ДО того, как появился фильтр по возрасту
    // (или устарел с тех пор) — перепроверяем теми же критериями, иначе
    // blue-chip вроде JUP/MET продолжит ATH-ренотифай бесконечно.
    if (!passesScannerFilters(token)) return;

    const ath = TokenAthRepo.get(address);
    const prevNotifiedAth = ath?.lastNotifiedAth ?? 0;
    const lastNotifiedAt = ath?.lastNotifiedAt ?? 0;

    // 1. Обновляем rolling-ATH в БД.
    TokenAthRepo.updateIfHigher(address, token.priceUsd);

    // 2. Триггер: новая цена выше last_notified_ath на pct%.
    // Если ещё ни разу не уведомляли (prevNotifiedAth === 0), считаем что
    // initial-уведомление было моментом первой регистрации в tokens и
    // запоминаем текущий ATH как «notified», чтобы не флудить сразу.
    if (prevNotifiedAth === 0) {
      TokenAthRepo.markNotified(address, token.priceUsd);
      return;
    }

    const threshold = prevNotifiedAth * (1 + config.athRenotify.pct / 100);
    if (token.priceUsd < threshold) return;

    // 3. Cooldown по времени.
    const cooldownMs = config.athRenotify.cooldownMin * 60_000;
    if (Date.now() - lastNotifiedAt * 1000 < cooldownMs) return;

    logger.info(
      `ATH re-notify candidate ${token.symbol} ${address}: ` +
        `price=$${token.priceUsd.toFixed(8)} > prev_notified=$${prevNotifiedAth.toFixed(8)} ` +
        `(threshold $${threshold.toFixed(8)}, +${config.athRenotify.pct}%)`
    );

    // 4. Помечаем сразу — иначе при ошибке колбэка зациклимся на каждом тике.
    TokenAthRepo.markNotified(address, token.priceUsd);

    for (const cb of this.callbacks) cb(token, token.priceUsd, prevNotifiedAth);
  }
}
