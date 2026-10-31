'use strict';

const { DEFAULT_VND_PER_USD } = require('../config/fx');
const { currentVndPerUsd, currentCnyPerUsd } = require('../finance/exchange-rate');

/**
 * Shared helpers for metered (usage) billing: currency → USD, token/character
 * unit sizes, time-unit normalization and Unicode-safe character counts.
 * Wallets are USD, so every rate must pass through `toUsd` before charging.
 */

/**
 * VND per USD. An explicit env bag (unit tests) still reads `VND_USD_RATE`.
 * The process environment does not pin the rate — that is only the fallback
 * inside the exchange-rate service, after the live provider and its cache.
 */
function vndPerUsd(env) {
  if (arguments.length && env !== process.env) {
    const n = Number(env && env.VND_USD_RATE);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_VND_PER_USD;
  }
  return currentVndPerUsd();
}

/**
 * Convert an amount in `currency` to USD.
 * USD amounts are unchanged. VND uses the shared rate (3rd arg or the live rate).
 * CNY uses the live CNY rate. Anything else is treated as already USD.
 */
function toUsd(amount, currency = 'USD', rate = vndPerUsd()) {
  const n = Number(amount) || 0;
  const code = String(currency || 'USD').trim().toUpperCase();
  if (code === 'VND' || code === 'VNĐ') return rate > 0 ? n / rate : n;
  if (code === 'CNY' || code === 'RMB') {
    const cny = currentCnyPerUsd();
    return cny > 0 ? n / cny : n;
  }
  return n;
}

/** Count user-visible characters: NFC code points (emoji = 1, precomposed Vietnamese = 1). */
function charCount(text) {
  if (text === undefined || text === null) return 0;
  return [...String(text).normalize('NFC')].length;
}

function scaleFromUnit(unit) {
  const m = String(unit || '').match(/(\d+(?:[.,]\d+)?)\s*([km])?\b/i);
  if (!m) return null;
  const base = Number(String(m[1]).replace(',', '.')) || 1;
  const suffix = (m[2] || '').toLowerCase();
  return base * (suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : 1);
}

/**
 * How many tokens one `usageRate` buys. Catalog convention: bare "tokens" is
 * priced per 1M (OpenAI/OpenRouter style); "1K tokens" per thousand; "per token" / "1 token" per token.
 */
function tokenUnitSize(unit) {
  const u = String(unit || '').trim().toLowerCase();
  if (/\b(million|mtok)\b/.test(u)) return 1e6;
  if (/\b(thousand|ktok)\b/.test(u)) return 1e3;
  const scaled = scaleFromUnit(u);
  if (scaled) return scaled;
  if (/^(per\s+|\/\s*)?token$/.test(u)) return 1;
  return 1e6;
}

/** Characters per `usageRate` ("1K characters" → 1000, "per character" → 1). Default 1000. */
function charUnitSize(unit) {
  const u = String(unit || '').trim().toLowerCase();
  const scaled = scaleFromUnit(u);
  if (scaled) return scaled;
  if (/^(per\s+|\/\s*)?(char|character|ký tự|ky tu)$/.test(u)) return 1;
  return 1000;
}

const TIME_PATTERNS = [
  ['second', /(^|[^a-z])(s|sec|secs|second|seconds|giây|giay)$/],
  ['minute', /(^|[^a-z])(m|min|mins|minute|minutes|phút|phut)$/],
  ['hour', /(^|[^a-z])(h|hr|hrs|hour|hours|giờ|gio)$/],
  ['day', /(^|[^a-z])(d|day|days|ngày|ngay)$/],
];

/**
 * Normalize human time units ("phút", "per minute", "/min", "1 minute", "GPU hour", "sec")
 * to second|minute|hour|day, or null when not a time unit.
 */
function normalizeTimeUnit(unit) {
  let u = String(unit || '').normalize('NFC').trim().toLowerCase();
  if (!u) return null;
  u = u.replace(/^(per|mỗi|moi|each|\/)\s*/, '').replace(/^\/\s*/, '').replace(/^\d+(?:[.,]\d+)?\s*/, '');
  u = u.replace(/^(gpu|vm|server)\s+/, '').trim();
  for (const [name, re] of TIME_PATTERNS) if (re.test(u)) return name;
  return null;
}

const SECONDS_PER = { second: 1, minute: 60, hour: 3600, day: 86400 };

function timeUnitSeconds(unit) {
  const t = normalizeTimeUnit(unit);
  return t ? SECONDS_PER[t] : null;
}

/** Convert `rate` per `unit` (+ currency) into USD per hour, or null if `unit` is not a time unit. */
function ratePerHourUsd(rate, unit, currency = 'USD') {
  const sec = timeUnitSeconds(unit);
  if (!sec) return null;
  return toUsd(Number(rate) || 0, currency) * (3600 / sec);
}

module.exports = {
  vndPerUsd,
  toUsd,
  charCount,
  tokenUnitSize,
  charUnitSize,
  normalizeTimeUnit,
  timeUnitSeconds,
  ratePerHourUsd,
};
