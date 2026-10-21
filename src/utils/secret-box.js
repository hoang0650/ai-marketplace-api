const crypto = require('crypto');

/**
 * AES-256-GCM envelope for user-supplied secrets (BYOK provider keys, Git tokens,
 * Hermes dashboard passwords).
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 * Key = SHA256(BYOK_ENCRYPTION_KEY). The key must be a dedicated random value
 * of at least 32 characters, set on the API. There is no fallback: a missing
 * key fails closed so secrets are never sealed under JWT_SECRET or a fixed string.
 * Rotating BYOK_ENCRYPTION_KEY makes stored envelopes unreadable (users re-enter keys).
 */
const VERSION = 'v1';
const MIN_KEY_LENGTH = 32;

function resolveKeyMaterial() {
  const explicit = String(process.env.BYOK_ENCRYPTION_KEY || '').trim();
  if (explicit.length < MIN_KEY_LENGTH) {
    throw new Error(
      'BYOK_ENCRYPTION_KEY must be set to a dedicated random value of at least 32 characters.',
    );
  }
  return explicit;
}

function key() {
  return crypto.createHash('sha256').update(resolveKeyMaterial(), 'utf8').digest();
}

function sealSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function openSecret(sealed) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unsupported secret envelope');
  }
  const [, iv, tag, ciphertext] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, 'base64url')));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { sealSecret, openSecret };
