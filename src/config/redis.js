/**
 * Redis client — on by default (127.0.0.1:6379), same fail-fast pattern as phhotel-api.
 *
 * Disable with REDIS_ENABLED=0. Production typically sets REDIS_URL (Upstash / Redis Cloud).
 * When Redis is down, cache helpers fail-open so Mongo still serves requests.
 */
const redisUrl = (process.env.REDIS_URL || '').trim();

function redisEnabled() {
  if (process.env.NODE_TEST_CONTEXT) return false;
  const v = String(process.env.REDIS_ENABLED || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return true;
}

const isRedisEnabled = redisEnabled();
const redisHost = (process.env.REDIS_HOST || '127.0.0.1').trim();
const redisPort = Number(process.env.REDIS_PORT) || 6379;

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
        host: redisHost,
        port: redisPort,
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
  console.log('[redis] disabled (REDIS_ENABLED=0)');
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
