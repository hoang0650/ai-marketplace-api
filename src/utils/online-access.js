/**
 * Online-only access for licensed datasets, skill packs, AI films and stories.
 *
 * - Buyers never receive raw files. They use the content online (rows API, server-side skill runs,
 *   streaming, reader) with their own license key, checked on every request.
 * - A license key only counts when it was issued to the calling account.
 * - The listing's seller keeps access to their own files ('owner'); admins get an explicitly
 *   labelled moderation access ('moderation').
 */
const crypto = require('crypto');
const config = require('../config/env');
const LicenseKey = require('../models/LicenseKey');
const OnlineAccessUsage = require('../models/OnlineAccessUsage');
const { effectiveLicenseStatus, licenseCoversProduct } = require('./license-keys');

const ONLINE_ONLY_CATEGORIES = new Set(['dataset', 'skill-pack', 'ai-film-series', 'story-book']);

function isOnlineOnlyCategory(category) {
  return ONLINE_ONLY_CATEGORIES.has(String(category || ''));
}

function num(envName, fallback) {
  const v = Number(process.env[envName]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Documented defaults; each can be tuned with the optional env var named next to it. */
function quotaDefaults() {
  return {
    dataset: {
      defaultLimit: 100,
      maxLimit: num('ONLINE_DATASET_MAX_LIMIT', 500),
      requestsPerMinute: num('ONLINE_DATASET_RPM', 60),
      rowsPerMinute: num('ONLINE_DATASET_ROWS_PER_MIN', 3000),
      rowsPerDay: num('ONLINE_DATASET_ROWS_PER_DAY', 30000),
    },
    skill: {
      requestsPerMinute: num('ONLINE_SKILL_RPM', 30),
      requestsPerDay: num('ONLINE_SKILL_RUNS_PER_DAY', 1000),
    },
    play: {
      requestsPerMinute: num('ONLINE_PLAY_UNLOCK_RPM', 60),
      requestsPerDay: num('ONLINE_PLAY_UNLOCKS_PER_DAY', 1500),
    },
    read: {
      requestsPerMinute: num('ONLINE_READ_PAGES_PER_MIN', 120),
      requestsPerDay: num('ONLINE_READ_PAGES_PER_DAY', 3000),
    },
  };
}

function licenseBelongsTo(license, userId) {
  if (!license || !userId) return false;
  return String(license.buyer?._id || license.buyer || '') === String(userId);
}

function cleanKey(key) {
  return String(key || '').trim().toUpperCase();
}

/** The caller's own active license for this product (by key when given, else newest of theirs). */
async function findOwnActiveLicense({ userId, productId, licenseKey, requireKey = false }) {
  if (!userId || !productId) return null;
  const key = cleanKey(licenseKey);
  const pid = String(productId);
  let docs = [];
  if (key) {
    const byKey = await LicenseKey.findOne({ licenseKey: key });
    docs = byKey ? [byKey] : [];
  } else if (!requireKey) {
    docs = await LicenseKey.find({ buyer: userId, product: pid }).sort({ expiresAt: -1 }).limit(8);
  }
  for (const doc of docs) {
    if (!licenseBelongsTo(doc, userId)) continue;
    if (!licenseCoversProduct(doc, pid)) continue;
    if (effectiveLicenseStatus(doc) === 'active') return doc;
  }
  return null;
}

/** Why a caller has no active license: LICENSE_EXPIRED when their own license for this product lapsed, else LICENSE_REQUIRED. */
async function missingLicenseReason({ userId, productId, licenseKey }) {
  if (!userId || !productId) return 'LICENSE_REQUIRED';
  const key = cleanKey(licenseKey);
  const pid = String(productId);
  const docs = key
    ? [await LicenseKey.findOne({ licenseKey: key })].filter(Boolean)
    : await LicenseKey.find({ buyer: userId, product: pid }).sort({ expiresAt: -1 }).limit(8);
  const lapsed = docs.some((d) => licenseBelongsTo(d, userId) && licenseCoversProduct(d, pid)
    && d.status !== 'revoked' && effectiveLicenseStatus(d) !== 'active');
  return lapsed ? 'LICENSE_EXPIRED' : 'LICENSE_REQUIRED';
}

/**
 * { via: 'moderation' | 'owner' | 'license' | null, license, reason }
 * reason (when via is null): AUTH_REQUIRED | LICENSE_KEY_REQUIRED | LICENSE_NOT_YOURS | LICENSE_EXPIRED | LICENSE_REQUIRED
 */
async function resolveOnlineAccess({ user, product, licenseKey, requireKey = false }) {
  if (!user) return { via: null, license: null, reason: 'AUTH_REQUIRED' };
  if (user.role === 'admin') return { via: 'moderation', license: null };
  if (String(product.creator) === String(user._id)) return { via: 'owner', license: null };
  const key = cleanKey(licenseKey);
  if (requireKey && !key) return { via: null, license: null, reason: 'LICENSE_KEY_REQUIRED' };
  const license = await findOwnActiveLicense({ userId: user._id, productId: product._id, licenseKey: key, requireKey });
  if (license) return { via: 'license', license };
  if (key) {
    const doc = await LicenseKey.findOne({ licenseKey: key }).lean();
    if (doc && !licenseBelongsTo(doc, user._id)) return { via: null, license: null, reason: 'LICENSE_NOT_YOURS' };
    if (doc && licenseCoversProduct(doc, String(product._id))) return { via: null, license: null, reason: 'LICENSE_EXPIRED' };
  }
  return { via: null, license: null, reason: 'LICENSE_REQUIRED' };
}

const DENY_MESSAGES = {
  AUTH_REQUIRED: 'Sign in (Bearer JWT or mk_live_ API key) to use this product online.',
  LICENSE_KEY_REQUIRED: 'Send your license key in the X-License-Key header.',
  LICENSE_NOT_YOURS: 'This license key was issued to another account.',
  LICENSE_EXPIRED: 'Your license has expired. Renew it on the product page to continue.',
  LICENSE_REQUIRED: 'An active license for this product is required.',
};

function denyStatus(reason) {
  if (reason === 'AUTH_REQUIRED') return 401;
  if (reason === 'LICENSE_NOT_YOURS') return 403;
  return 402;
}

function sendDenied(res, reason) {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(denyStatus(reason)).json({ message: DENY_MESSAGES[reason] || DENY_MESSAGES.LICENSE_REQUIRED, code: reason });
}

function onlineOnlyBody(product) {
  return {
    message: 'This product is online-only: buyers use it through the API / player / reader, raw files are not downloadable.',
    code: 'ONLINE_ONLY',
    online: onlineEndpoints(product),
  };
}

function onlineEndpoints(product) {
  const slug = product?.slug || '';
  const c = String(product?.category || '');
  if (c === 'dataset') return { meta: `/v1/datasets/${slug}`, rows: `/v1/datasets/${slug}/rows?split=train&offset=0&limit=100` };
  if (c === 'skill-pack') return { meta: `/v1/skills/${slug}`, run: `/v1/skills/${slug}/run`, loader: `/v1/skills/${slug}/loader.zip` };
  return { episodes: `/v1/content/products/${slug}/episodes`, unlock: '/v1/content/unlock' };
}

function secret() {
  const s = String(config.contentDrmSecret || config.jwtSecret || '').trim() || 'aimarkets-online-dev';
  return crypto.createHash('sha256').update(`online-access:${s}`).digest();
}

function hmac(text) {
  return crypto.createHmac('sha256', secret()).update(String(text)).digest('base64url');
}

/** Per-response trace id: verifiable against a license id (see verifyTrace) without storing it. */
function traceId(scopeId, now = Date.now()) {
  const ts = Math.floor(now / 1000).toString(36);
  return `t_${ts}_${hmac(`${scopeId}|${ts}`).slice(0, 12)}`;
}

function verifyTrace(trace, scopeId) {
  const m = /^t_([0-9a-z]+)_([\w-]{12})$/.exec(String(trace || ''));
  if (!m) return false;
  return hmac(`${scopeId}|${m[1]}`).slice(0, 12) === m[2];
}

/** Deterministic per-license row fingerprint: leaked rows can be attributed to one license. */
function rowWatermark(scopeId, productId, split, index) {
  return hmac(`row|${scopeId}|${productId}|${split}|${index}`).slice(0, 10);
}

function usageScope(access, user, product) {
  if (access?.license?._id) return `lic:${access.license._id}`;
  return `user:${user?._id || 'anon'}:${product?._id || ''}`;
}

function quotaError(retryAfterSec, detail) {
  const err = new Error(`Quota exceeded (${detail}). Slow down and retry later.`);
  err.status = 429;
  err.code = 'QUOTA_EXCEEDED';
  err.retryAfter = Math.max(1, Math.ceil(retryAfterSec));
  return err;
}

function windows(now = Date.now()) {
  const minute = Math.floor(now / 60000);
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    m: { id: String(minute), resetSec: 60 - Math.floor((now % 60000) / 1000), expireAt: new Date((minute + 2) * 60000) },
    d: { id: day, resetSec: Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86400000 - now) / 1000), expireAt: new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86400000) },
  };
}

async function readUsage(scope, kind, now = Date.now()) {
  const w = windows(now);
  const keys = { m: `${scope}|${kind}|m|${w.m.id}`, d: `${scope}|${kind}|d|${w.d.id}` };
  const rows = await OnlineAccessUsage.find({ key: { $in: [keys.m, keys.d] } }).lean();
  const by = Object.fromEntries(rows.map((r) => [r.window, r]));
  return { w, keys, m: by.m || { requests: 0, units: 0 }, d: by.d || { requests: 0, units: 0 } };
}

async function addUsage(scope, kind, units, u) {
  const ops = ['m', 'd'].map((win) =>
    OnlineAccessUsage.updateOne(
      { key: u.keys[win] },
      { $inc: { requests: 1, units: units || 0 }, $setOnInsert: { scope, kind, window: win, expireAt: u.w[win].expireAt } },
      { upsert: true }
    )
  );
  await Promise.all(ops);
}

/**
 * Check + record one request. limits: { requestsPerMinute, requestsPerDay?, unitsPerMinute?, unitsPerDay? }.
 * wantUnits is how many units (rows) the caller asks for; returns { allowedUnits, remaining, commit(units) }.
 */
async function takeQuota({ scope, kind, limits, wantUnits = 0, now = Date.now() }) {
  const u = await readUsage(scope, kind, now);
  if (limits.requestsPerMinute && u.m.requests >= limits.requestsPerMinute) throw quotaError(u.w.m.resetSec, `${limits.requestsPerMinute} requests/minute`);
  if (limits.requestsPerDay && u.d.requests >= limits.requestsPerDay) throw quotaError(u.w.d.resetSec, `${limits.requestsPerDay} requests/day`);
  let allowedUnits = wantUnits;
  if (wantUnits) {
    const leftM = limits.unitsPerMinute ? limits.unitsPerMinute - u.m.units : Infinity;
    const leftD = limits.unitsPerDay ? limits.unitsPerDay - u.d.units : Infinity;
    if (leftD <= 0) throw quotaError(u.w.d.resetSec, `${limits.unitsPerDay} rows/day`);
    if (leftM <= 0) throw quotaError(u.w.m.resetSec, `${limits.unitsPerMinute} rows/minute`);
    allowedUnits = Math.max(0, Math.min(wantUnits, leftM, leftD));
  }
  const remaining = {
    requestsThisMinute: limits.requestsPerMinute ? Math.max(0, limits.requestsPerMinute - u.m.requests - 1) : null,
    unitsToday: limits.unitsPerDay ? Math.max(0, limits.unitsPerDay - u.d.units) : null,
  };
  return {
    allowedUnits,
    remaining,
    commit: async (units = 0) => {
      await addUsage(scope, kind, units, u);
      if (remaining.unitsToday != null) remaining.unitsToday = Math.max(0, remaining.unitsToday - units);
    },
  };
}

function sendQuotaError(res, err) {
  res.setHeader('Retry-After', String(err.retryAfter || 60));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(429).json({ message: err.message, code: err.code, retryAfterSec: err.retryAfter });
}

module.exports = {
  ONLINE_ONLY_CATEGORIES,
  isOnlineOnlyCategory,
  quotaDefaults,
  licenseBelongsTo,
  findOwnActiveLicense,
  missingLicenseReason,
  resolveOnlineAccess,
  sendDenied,
  denyStatus,
  DENY_MESSAGES,
  onlineOnlyBody,
  onlineEndpoints,
  traceId,
  verifyTrace,
  rowWatermark,
  usageScope,
  takeQuota,
  sendQuotaError,
  quotaError,
};
