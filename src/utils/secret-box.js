const crypto = require('crypto');

/**
 * AES-256-GCM envelope for user-supplied secrets (BYOK provider keys).
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url). Key = SHA256(BYOK_ENCRYPTION_KEY).
 * Rotating BYOK_ENCRYPTION_KEY makes stored keys unreadable (users must re-enter).
 */
const VERSION = 'v1';
let warned = false;

function resolveKeyMaterial() {
  const explicit = String(process.env.BYOK_ENCRYPTION_KEY || '').trim();
  if (explicit) return explicit;
  const fallback = String(process.env.JWT_SECRET || '').trim();
  if (!warned) {
    warned = true;
    console.warn(
      '[secret-box] BYOK_ENCRYPTION_KEY is not set — deriving from JWT_SECRET. Set a dedicated random value (>= 32 chars).'
    );
  }
  return `byok-v1:${fallback || 'phai-market-dev-secret'}`;
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
