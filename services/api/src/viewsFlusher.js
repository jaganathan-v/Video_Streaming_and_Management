import { redis } from './redis.js';
import { query } from './db.js';
import logger from './logger.js';

let flushTimer = null;

// Atomic Lua script to fetch count and delete key in one single operation across all replicas
const TAKE_VIEWS_SCRIPT = `
local count = redis.call('get', KEYS[1])
if count and tonumber(count) > 0 then
    redis.call('del', KEYS[1])
    return tonumber(count)
else
    return 0
end
`;

export async function flushViewCounts() {
  try {
    const keys1 = await redis.keys('video:*:views');
    const keys2 = await redis.keys('views:*');
    const allKeys = [...new Set([...keys1, ...keys2])];
    if (allKeys.length === 0) return;

    let flushedAny = false;

    for (const key of allKeys) {
      let videoId = null;
      if (key.startsWith('video:')) {
        // video:{id}:views
        const parts = key.split(':');
        if (parts.length >= 3) {
          videoId = parts[1];
        }
      } else {
        // views:{id}
        videoId = key.split(':')[1];
      }

      if (!videoId) continue;

      const count = await redis.eval(TAKE_VIEWS_SCRIPT, 1, key);
      if (count && count > 0) {
        flushedAny = true;
        await query(
          'UPDATE videos SET views = views + $1, updated_at = now() WHERE id = $2',
          [count, videoId]
        );
        // Invalidate single video cache so next read fetches the fresh DB view count
        await redis.del(`video:${videoId}`);
      }
    }

    if (flushedAny) {
      const listKeys = await redis.keys('videos:list:*');
      if (listKeys.length > 0) {
        await redis.del(...listKeys);
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
