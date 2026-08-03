/**
 * Cache helper with circuit breaker — mirrors the hardened phhotel-api pattern.
 *
 * - Every operation has a hard timeout (default 250ms) so a slow Redis can
 *   never make an API request slower than the DB fallback.
 * - After N consecutive failures the circuit opens and Redis is skipped
 *   entirely for a cool-down window (fail-open: callers just hit MongoDB).
 */
const { getClient, isReady } = require('../config/redis');

const OP_TIMEOUT_MS = Number(process.env.CACHE_OP_TIMEOUT_MS) || 250;
const CIRCUIT_FAIL_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 30_000;

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function isCacheAvailable() {
  if (!isReady()) return false;
  if (Date.now() < circuitOpenUntil) return false;
  return true;
}

function recordSuccess() {
  consecutiveFailures = 0;
}

function recordFailure(op, err) {
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_FAIL_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    consecutiveFailures = 0;
    console.warn(`[cache] circuit open for ${CIRCUIT_OPEN_MS}ms after repeated failures (${op}: ${err?.message || err})`);
  }
}

function withTimeout(promise, ms = OP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cache op timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

async function getCache(key) {
  if (!isCacheAvailable()) return null;
  try {
    const raw = await withTimeout(getClient().get(key));
    recordSuccess();
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    recordFailure('get', err);
    return null;
  }
}

async function setCache(key, value, ttlSeconds = 60) {
  if (!isCacheAvailable()) return false;
  try {
    await withTimeout(getClient().set(key, JSON.stringify(value), 'EX', ttlSeconds));
    recordSuccess();
    return true;
  } catch (err) {
    recordFailure('set', err);
    return false;
  }
}

async function deleteCache(...keys) {
  if (!isCacheAvailable() || keys.length === 0) return false;
  try {
    await withTimeout(getClient().del(...keys));
    recordSuccess();
    return true;
  } catch (err) {
    recordFailure('del', err);
    return false;
  }
}

/** Delete keys by prefix using SCAN (never KEYS — safe in production). */
async function deleteCachePattern(pattern) {
  if (!isCacheAvailable()) return false;
  try {
    const client = getClient();
    let cursor = '0';
    do {
      const [next, keys] = await withTimeout(
        client.scan(cursor, 'MATCH', pattern, 'COUNT', 100),
        1000
      );
      cursor = next;
      if (keys.length) await withTimeout(client.del(...keys), 1000);
    } while (cursor !== '0');
    recordSuccess();
    return true;
  } catch (err) {
    recordFailure('scan-del', err);
    return false;
  }
}

/**
 * Read-through helper: return cached value or compute + cache it.
 * On any cache failure it silently falls back to `compute()`.
 */
async function cached(key, ttlSeconds, compute) {
  const hit = await getCache(key);
  if (hit !== null) return hit;
  const value = await compute();
  if (value !== undefined && value !== null) {
    // Fire-and-forget: caller never waits on the write.
    setCache(key, value, ttlSeconds).catch(() => {});
  }
  return value;
}

module.exports = {
  getCache,
  setCache,
  deleteCache,
  deleteCachePattern,
  cached,
  isCacheAvailable,
};
