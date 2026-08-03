/**
 * Optional Redis client — fail-fast, never blocks the API when Redis is down.
 *
 * Enable via REDIS_URL (Upstash/Render/Redis Cloud) or REDIS_ENABLED=true + REDIS_HOST.
 * When disabled/unavailable every command resolves to null (no-op cache).
 */
const redisUrl = (process.env.REDIS_URL || '').trim();
const isRedisEnabled = !!redisUrl || (process.env.REDIS_ENABLED === 'true' && !!process.env.REDIS_HOST);

let redis = null;
let redisReady = false;

if (isRedisEnabled) {
  try {
    const { Redis } = require('ioredis');
    const baseOptions = {
      // Fail fast — never hang requests on a dead Redis
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 1500,
      commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 250,
      maxRetriesPerRequest: 0,
      enableReadyCheck: true,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 3) {
          console.warn('[redis] unavailable, running without cache');
          redisReady = false;
          return null;
        }
        return Math.min(times * 200, 1000);
      },
    };

    if (redisUrl) {
      redis = new Redis(redisUrl, baseOptions);
    } else {
      redis = new Redis({
        ...baseOptions,
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT) || 6379,
        username: process.env.REDIS_USERNAME || undefined,
        password: process.env.REDIS_PASSWORD || undefined,
      });
    }

    redis.on('ready', () => {
      redisReady = true;
      console.log('[redis] ready');
    });
    redis.on('error', (err) => {
      redisReady = false;
      console.warn('[redis] error:', err?.message || err);
    });
    redis.on('close', () => {
      redisReady = false;
    });

    redis.connect().catch((err) => {
      redisReady = false;
      console.warn('[redis] not available, app will run without cache:', err?.message || err);
    });
  } catch (err) {
    console.warn('[redis] init failed, running without cache:', err?.message || err);
  }
} else {
  console.log('[redis] disabled, running without cache');
}

function isReady() {
  return !!(redis && redisReady);
}

function getClient() {
  return redis;
}

async function closeRedis() {
  if (!redis) return;
  try {
    await redis.quit();
  } catch (_) {
    try {
      redis.disconnect();
    } catch (_) {}
  }
}

module.exports = { getClient, isReady, closeRedis };
