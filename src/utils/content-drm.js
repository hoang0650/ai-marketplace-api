const crypto = require('crypto');
const config = require('../config/env');
const LicenseKey = require('../models/LicenseKey');
const { effectiveLicenseStatus, licenseCoversProduct } = require('./license-keys');

const MAGIC = Buffer.from('AIMC');
const PLAY_TTL_MS = 5 * 60 * 1000;
const playTokens = new Map();

function drmSecret() {
  const s = String(config.contentDrmSecret || config.jwtSecret || '').trim();
  return crypto.createHash('sha256').update(s || 'aimarkets-content-drm-dev').digest();
}

/** Per-episode AES key — never stored in the downloaded file. */
function episodeDek(episodeId) {
  return crypto.createHmac('sha256', drmSecret()).update(String(episodeId)).digest();
}

function encryptBuffer(plain, episodeId) {
  const key = episodeDek(episodeId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext };
}

function decryptBuffer({ iv, tag, ciphertext }, episodeId) {
  const key = episodeDek(episodeId);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function packAimc({ episodeId, productId, mime, filename, plain }) {
  const { iv, tag, ciphertext } = encryptBuffer(plain, episodeId);
  const header = Buffer.from(
    JSON.stringify({
      v: 1,
      episodeId: String(episodeId),
      productId: String(productId),
      mime: mime || 'application/octet-stream',
      filename: filename || 'episode.bin',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    }),
    'utf8',
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, len, header, ciphertext]);
}

function parseAimcHeader(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 4).equals(MAGIC)) return null;
  const len = buf.readUInt32BE(4);
  if (buf.length < 8 + len) return null;
  try {
    return JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
  } catch {
    return null;
  }
}

function prunePlayTokens(now = Date.now()) {
  for (const [k, v] of playTokens) {
    if (!v || v.expires <= now) playTokens.delete(k);
  }
}

function issuePlayToken({ episodeId, productId, licenseId, mime, userId, trace }) {
  prunePlayTokens();
  const payload = Buffer.from(
    JSON.stringify({
      e: String(episodeId),
      p: String(productId),
      l: licenseId ? String(licenseId) : '',
      u: userId ? String(userId) : '',
      t: trace ? String(trace) : '',
      m: mime || 'application/octet-stream',
      exp: Date.now() + PLAY_TTL_MS,
    }),
    'utf8',
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', drmSecret()).update(payload).digest('base64url');
  const token = `${payload}~${sig}`;
  playTokens.set(token, {
    episodeId: String(episodeId),
    productId: String(productId),
    licenseId: licenseId ? String(licenseId) : '',
    userId: userId ? String(userId) : '',
    trace: trace ? String(trace) : '',
    mime: mime || 'application/octet-stream',
    expires: Date.now() + PLAY_TTL_MS,
  });
  return token;
}

function takePlayToken(token) {
  prunePlayTokens();
  let raw = String(token || '');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* already decoded */
  }
  const cached = playTokens.get(raw);
  if (cached && cached.expires > Date.now()) return cached;

  const parts = raw.split('~');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expect = crypto.createHmac('sha256', drmSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let row;
  try {
    row = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!row || Number(row.exp) <= Date.now()) return null;
  return {
    episodeId: String(row.e || ''),
    productId: String(row.p || ''),
    licenseId: String(row.l || ''),
    userId: String(row.u || ''),
    trace: String(row.t || ''),
    mime: row.m || 'application/octet-stream',
    expires: Number(row.exp),
  };
}

async function findActiveLicense({ buyerId, licenseKey, productId }) {
  const pid = productId ? String(productId) : '';
  const key = String(licenseKey || '').trim().toUpperCase();
  const seen = new Set();
  const docs = [];

  // A key only counts for the account it was issued to (online-only: keys are not bearer tokens).
  if (key && buyerId) {
    const byKey = await LicenseKey.findOne({ licenseKey: key });
    if (byKey && String(byKey.buyer?._id || byKey.buyer || '') === String(buyerId)) docs.push(byKey);
  }
  if (buyerId && pid) {
    const byBuyer = await LicenseKey.find({ buyer: buyerId, product: pid })
      .sort({ expiresAt: -1 })
      .limit(8);
    docs.push(...byBuyer);
  }

  for (const doc of docs) {
    const id = String(doc._id);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!licenseCoversProduct(doc, pid)) continue;
    if (effectiveLicenseStatus(doc) === 'active') return doc;
  }
  return null;
}

function resolveEpisodePages(episode) {
  const o = episode && typeof episode.toObject === 'function' ? episode.toObject() : { ...(episode || {}) };
  const raw = Array.isArray(o.pages) ? o.pages : [];
  const pages = raw
    .map((p, i) => ({
      index: Math.max(1, Number(p?.index) || i + 1),
      objectName: String(p?.objectName || ''),
      bucket: String(p?.bucket || ''),
      contentType: String(p?.contentType || o.contentType || ''),
      size: Number(p?.size) || 0,
      sourceUrl: String(p?.sourceUrl || ''),
    }))
    .filter((p) => p.objectName || p.sourceUrl)
    .sort((a, b) => a.index - b.index);
  if (pages.length) return pages;
  if (o.objectName || o.sourceUrl) {
    return [
      {
        index: 1,
        objectName: String(o.objectName || ''),
        bucket: String(o.bucket || ''),
        contentType: String(o.contentType || ''),
        size: Number(o.size) || 0,
        sourceUrl: String(o.sourceUrl || ''),
      },
    ];
  }
  return [];
}

function publicEpisode(doc) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  const pageCount = Math.max(1, resolveEpisodePages(o).length || 1);
  return {
    id: String(o._id || o.id),
    productId: String(o.product?._id || o.product),
    index: o.index || 1,
    title: o.title || '',
    kind: o.kind,
    mime: o.contentType || '',
    durationSec: o.durationSec || 0,
    size: o.size || 0,
    previewUrl: o.previewUrl || '',
    published: o.published !== false,
    free: o.free === true,
    synopsis: o.synopsis || '',
    posterUrl: o.posterUrl || '',
    pageCount,
    // Story narration made from a text chapter: which chapter it reads (timings only come with /unlock).
    narrationFor: o.narration?.forEpisode ? String(o.narration.forEpisode) : null,
    narrationStatus: o.narration?.status || null,
    narrationModel: o.narration?.model || null,
  };
}

module.exports = {
  PLAY_TTL_MS,
  episodeDek,
  encryptBuffer,
  decryptBuffer,
  packAimc,
  parseAimcHeader,
  issuePlayToken,
  takePlayToken,
  playTokens,
  findActiveLicense,
  publicEpisode,
  resolveEpisodePages,
};
