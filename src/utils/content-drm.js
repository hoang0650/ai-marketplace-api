const crypto = require('crypto');
const config = require('../config/env');
const LicenseKey = require('../models/LicenseKey');
const { effectiveLicenseStatus } = require('./license-keys');

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

function issuePlayToken({ episodeId, productId, licenseId, mime }) {
  prunePlayTokens();
  const token = crypto.randomBytes(18).toString('base64url');
  playTokens.set(token, {
    episodeId: String(episodeId),
    productId: String(productId),
    licenseId: licenseId ? String(licenseId) : '',
    mime: mime || 'application/octet-stream',
    expires: Date.now() + PLAY_TTL_MS,
  });
  return token;
}

function takePlayToken(token) {
  prunePlayTokens();
  const row = playTokens.get(String(token || ''));
  if (!row) return null;
  return row;
}

async function findActiveLicense({ buyerId, licenseKey, productId }) {
  const pid = productId ? String(productId) : '';
  let doc = null;
  const key = String(licenseKey || '').trim().toUpperCase();
  if (key) {
    doc = await LicenseKey.findOne({ licenseKey: key });
  } else if (buyerId && pid) {
    doc = await LicenseKey.findOne({ buyer: buyerId, product: pid }).sort({ expiresAt: -1 });
  }
  if (!doc) return null;
  if (pid && String(doc.product) !== pid) return null;
  if (effectiveLicenseStatus(doc) !== 'active') return null;
  return doc;
}

function publicEpisode(doc) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
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
  findActiveLicense,
  publicEpisode,
};
