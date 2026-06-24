import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { logger } from './logger';

/**
 * Простая FIFO-очередь с throttle между вызовами и exponential backoff
 * на 429/5xx. По одной очереди на источник (DexScreener, GMGN, RugCheck,
 * BubbleMaps, Meteora) — лимиты у них разные, общий пул был бы недостаточен.
 *
 * Не зависим от p-queue, чтобы не плодить deps.
 */

interface QueueTask<T> {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
}

export class HttpQueue {
  private queue: QueueTask<unknown>[] = [];
  private running = false;
  private lastCallAt = 0;

  constructor(
    public readonly name: string,
    private throttleMs: number,
    private maxRetries: number = 3
  ) {}

  async get<T = any>(url: string, cfg?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.enqueue(() => axios.get<T>(url, cfg));
  }

  async post<T = any>(
    url: string,
    body: unknown,
    cfg?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.enqueue(() => axios.post<T>(url, body, cfg));
  }

  private enqueue<T>(fn: () => Promise<AxiosResponse<T>>): Promise<AxiosResponse<T>> {
    return new Promise<AxiosResponse<T>>((resolve, reject) => {
      this.queue.push({
        run: () => this.withRetry(fn),
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const wait = this.throttleMs - (Date.now() - this.lastCallAt);
        if (wait > 0) await sleep(wait);

        const task = this.queue.shift();
        if (!task) break;
        this.lastCallAt = Date.now();

        try {
          const result = await task.run();
          task.resolve(result);
        } catch (err) {
          task.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const status = (err as AxiosError)?.response?.status;
        // Retry: 429 (rate-limit) и 5xx. Остальные — сразу пробрасываем.
        if (status !== 429 && (status === undefined || status < 500)) {
          throw err;
        }
        if (attempt < this.maxRetries) {
          const delay = 500 * 2 ** (attempt - 1); // 500 / 1000 / 2000 ms
          logger.warn(
            `[${this.name}] HTTP ${status ?? 'network'} attempt ${attempt}/${this.maxRetries}, retry in ${delay}ms`
          );
          await sleep(delay);
        }
      }
    }
    throw lastErr;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Одна очередь на источник. 200ms throttle — рекомендация ТЗ для DexScreener.
export const dexscreenerQ = new HttpQueue('DexScreener', 200);
export const meteoraQ = new HttpQueue('Meteora', 200);
export const gmgnQ = new HttpQueue('GMGN', 500);
export const rugcheckQ = new HttpQueue('RugCheck', 500);
export const bubblemapsQ = new HttpQueue('BubbleMaps', 500);
