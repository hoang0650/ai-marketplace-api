/**
 * Request signing shared by the AI Markets API and the bootstrap issuer.
 * Key is derived from SSH_GATEWAY_SHARED_SECRET for this one purpose, so a
 * signature can't be replayed against the SSH endpoints (and vice versa).
 * MUST stay byte-identical to src/services/openclaw-bootstrap.js in the API.
 */
const crypto = require('crypto');

const KEY_LABEL = 'aim-openclaw-bootstrap-issuer/v1';
const MAX_SKEW_MS = 60_000;

function deriveKey(secret) {
  return crypto.createHmac('sha256', String(secret)).update(KEY_LABEL).digest();
}

function signingString(ts, nonce, body) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return `v1\n${ts}\n${nonce}\n${bodyHash}`;
}

function sign(secret, ts, nonce, body) {
  return crypto.createHmac('sha256', deriveKey(secret)).update(signingString(ts, nonce, body)).digest('hex');
}

/** Constant-time check of ts/nonce/signature. Returns an error code or null. */
function verify(secret, { ts, nonce, sig, body, now = Date.now() }) {
  if (!/^\d{13}$/.test(String(ts || ''))) return 'bad_ts';
  if (Math.abs(now - Number(ts)) > MAX_SKEW_MS) return 'stale';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(nonce || ''))) return 'bad_nonce';
  if (!/^[a-f0-9]{64}$/.test(String(sig || ''))) return 'bad_sig';
  const want = Buffer.from(sign(secret, ts, nonce, body), 'hex');
  const got = Buffer.from(sig, 'hex');
  return crypto.timingSafeEqual(want, got) ? null : 'bad_sig';
}

module.exports = { sign, verify, deriveKey, MAX_SKEW_MS };
