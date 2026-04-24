import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';

let client: Redis | null = null;

export function getRedis(): Redis | null {
  if (client) return client;

  try {
    client = new Redis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    client.on('error', (err) => {
      logger.warn(`Redis error (caching disabled): ${err.message}`);
      client = null;
    });
    return client;
  } catch {
    logger.warn('Redis unavailable, caching disabled');
    return null;
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key, value, 'EX', ttlSeconds);
  } catch {
    // silent — redis is optional
  }
}
