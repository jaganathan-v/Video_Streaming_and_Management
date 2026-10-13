import { redis } from './redis.js';
import { query } from './db.js';
import logger from './logger.js';

let flushTimer = null;

export async function flushViewCounts() {
  try {
    const keys = await redis.keys('views:*');
    if (!keys || keys.length === 0) return;

    for (const key of keys) {
      const videoId = key.split(':')[1];
      // Atomic get and del/decrement
      const countStr = await redis.get(key);
      const count = parseInt(countStr, 10);
      if (count > 0) {
        // Decrement by the fetched count or reset
        await redis.decrby(key, count);
        await query(
          'UPDATE videos SET views = views + $1, updated_at = now() WHERE id = $2',
          [count, videoId]
        );
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error flushing view counts to PostgreSQL');
  }
}

export function startViewCountFlusher(intervalMs = 10000) {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(flushViewCounts, intervalMs);
  logger.info({ intervalMs }, 'View count flusher started');
}

export function stopViewCountFlusher() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
