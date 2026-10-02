const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { JWT_VERIFY } = require('../middleware/auth');
const { assertSafeHttpUrl } = require('./safe-http-url');
const minio = require('../config/minio');
const { publicPayload } = require('./white-label');

const MAX_REDIRECTS = 4;
const MAX_URLS = 16;
const MAX_DEPTH = 6;
const LINK_TTL_S = 7 * 24 * 3600;
const MEDIA_TYPE_RE = /^(image|video|audio)\//i;
const OWN_HOST_RE = /(^|\.)aimarkets\.vn$/i;

function maxBytes() {
  const mb = Number(process.env.MEDIA_REHOST_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 150) * 1024 * 1024;
}

function ownHosts() {
  const hosts = minio.mediaHosts();
  for (const raw of [process.env.PUBLIC_API_URL, process.env.AIMARKETS_API_HOST]) {
    try {
      if (raw) hosts.add(new URL(String(raw).trim()).hostname.toLowerCase());
    } catch {
      /* ignore malformed env */
    }
  }
  return hosts;
}

/** A remote http(s) URL that is not already served from our own domains. */
function isForeignMediaUrl(value, own = ownHosts()) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value)) return false;
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return !OWN_HOST_RE.test(host) && !own.has(host) && host !== 'localhost' && host !== '127.0.0.1';
}

function signMediaLink(url) {
  return jwt.sign({ typ: 'media', u: url }, config.jwtSecret, { expiresIn: LINK_TTL_S, algorithm: 'HS256' });
}

function verifyMediaLink(token) {
  try {
    const p = jwt.verify(String(token || ''), config.jwtSecret, JWT_VERIFY);
    return p && p.typ === 'media' && typeof p.u === 'string' ? p.u : null;
  } catch {
    return null;
  }
}

function mediaLinkUrl(baseUrl, url) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/v1/media/${signMediaLink(url)}`;
}

/** GET with SSRF checks on every redirect hop; the body is left unread. */
async function openUpstream(url, { headers = {}, timeoutMs = 60_000 } = {}) {
  let current = await assertSafeHttpUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetch(current, {
      method: 'GET',
      headers: { 'User-Agent': 'AI-Markets-Media/1.0', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!loc) break;
      current = await assertSafeHttpUrl(new URL(loc, current).href);
      continue;
    }
    return res;
  }
  const err = new Error('Too many redirects');
  err.status = 502;
  throw err;
}

function byteLimit(limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) {
        const err = new Error('Media too large');
        err.code = 'MEDIA_TOO_LARGE';
        return cb(err);
      }
      return cb(null, chunk);
    },
  });
}

/** Copy one upstream media file into our public bucket and return its new URL. */
async function copyToBucket(url) {
  const res = await openUpstream(url, { timeoutMs: 120_000 });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    const err = new Error(`HTTP ${res.status}`);
    err.status = 502;
    throw err;
  }
  const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const declared = Number(res.headers.get('content-length')) || 0;
  const limit = maxBytes();
  if (!MEDIA_TYPE_RE.test(contentType) || declared > limit) {
    await res.body.cancel().catch(() => {});
    const err = new Error('Not a media file');
    err.code = 'NOT_MEDIA';
    throw err;
  }

  const cfg = await minio.ensurePlaygroundBucket();
  const client = minio.getMinioClient();
  const day = new Date().toISOString().slice(0, 10);
  const objectName = `${cfg.playgroundPrefix}/gen/${day}/${crypto.randomBytes(12).toString('hex')}.${minio.extForMime(contentType)}`;
  const guard = byteLimit(limit);
  const body = Readable.fromWeb(res.body);
  const upload = client.putObject(cfg.bucket, objectName, guard, declared || undefined, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  try {
    await Promise.all([pipeline(body, guard), upload]);
  } catch (err) {
    body.destroy();
    guard.destroy();
    throw err;
  }
  return minio.buildPublicObjectUrl(objectName);
}

/**
 * Replace upstream media URLs with URLs on our own domains.
 * MinIO copy first; otherwise a signed `/v1/media/<token>` link that streams through the API.
 */
async function rehostMediaUrl(url, { baseUrl } = {}) {
  if (!isForeignMediaUrl(url)) return url;
  if (minio.isMinioEnabled()) {
    try {
      return await copyToBucket(url);
    } catch {
      /* fall through to the signed proxy link */
    }
  }
  return mediaLinkUrl(baseUrl, url);
}

/** Walk a provider payload, drop our cost basis, and rehost every string value that is a foreign URL. */
async function rehostMediaDeep(input, { baseUrl } = {}) {
  const value = publicPayload(input);
  const own = ownHosts();
  const found = new Map();
  const collect = (node, depth) => {
    if (depth > MAX_DEPTH || found.size >= MAX_URLS || node == null) return;
    if (typeof node === 'string') {
      if (isForeignMediaUrl(node, own)) found.set(node, null);
      return;
    }
    if (Array.isArray(node)) return node.forEach((v) => collect(v, depth + 1));
    if (typeof node === 'object') Object.values(node).forEach((v) => collect(v, depth + 1));
  };
  collect(value, 0);
  if (!found.size) return value;

  await Promise.all(
    [...found.keys()].map(async (u) => {
      found.set(u, await rehostMediaUrl(u, { baseUrl }));
    })
  );

  const replace = (node, depth) => {
    if (depth > MAX_DEPTH || node == null) return node;
    if (typeof node === 'string') return found.get(node) || node;
    if (Array.isArray(node)) return node.map((v) => replace(v, depth + 1));
    if (typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = replace(v, depth + 1);
      return out;
    }
    return node;
  };
  return replace(value, 0);
}

function requestOrigin(req) {
  const env = String(process.env.PUBLIC_API_URL || process.env.AIMARKETS_API_HOST || '').trim().replace(/\/+$/, '');
  if (config.isProduction && /^https?:\/\//i.test(env)) return env;
  const xfProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || req?.protocol || 'https';
  const host = req?.get?.('host') || 'api.aimarkets.vn';
  return `${proto}://${host}`;
}

module.exports = {
  isForeignMediaUrl,
  signMediaLink,
  verifyMediaLink,
  mediaLinkUrl,
  openUpstream,
  rehostMediaUrl,
  rehostMediaDeep,
  requestOrigin,
};
