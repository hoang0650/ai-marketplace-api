/**
 * Self-serve OpenClaw Control UI pairing with a reduced-scope bootstrap token.
 *
 * OpenClaw's Control UI asks for operator.admin + operator.pairing on its first
 * pairing, which buyers must never get on the shared gateway. Instead, the API
 * asks the gateway-host issuer (infra/ssh-gateway/src/bootstrap-issuer.js) for a
 * single-use, 10-minute bootstrap token whose profile is fixed to the operator
 * role, purpose "control-ui" and non-admin scopes. Opened with that token, the
 * Control UI pairs this browser automatically with only those scopes.
 *
 * The token is only issued to the signed-in owner of the workspace and only
 * placed in the URL fragment (never sent to servers) of THEIR host
 * https://<userId>.openclaw.aimarkets.vn, next to their signed market ticket.
 */
const crypto = require('crypto');

const USER_ID_RE = /^[a-f0-9]{24}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,256}$/;
const FORBIDDEN = new Set(['operator.admin', 'operator.pairing']);
const KEY_LABEL = 'aim-openclaw-bootstrap-issuer/v1'; // same as infra/ssh-gateway/src/issuer-auth.js

function issuerConfig(env = process.env) {
  return {
    url: String(env.OPENCLAW_BOOTSTRAP_ISSUER_URL || '').trim(),
    secret: String(env.SSH_GATEWAY_SHARED_SECRET || '').trim(),
  };
}

function issuerEnabled(env = process.env) {
  const cfg = issuerConfig(env);
  return /^https:\/\//i.test(cfg.url) && cfg.secret.length >= 32;
}

function signRequest(secret, body, { ts = String(Date.now()), nonce = crypto.randomBytes(18).toString('base64url') } = {}) {
  const key = crypto.createHmac('sha256', secret).update(KEY_LABEL).digest();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const sig = crypto.createHmac('sha256', key).update(`v1\n${ts}\n${nonce}\n${bodyHash}`).digest('hex');
  return { 'X-Aim-Ts': ts, 'X-Aim-Nonce': nonce, 'X-Aim-Sig': sig };
}

class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Ask the gateway-host issuer for one reduced-scope Control UI bootstrap token. */
async function requestBootstrapToken({ userId, fetchImpl = fetch, env = process.env }) {
  const uid = String(userId || '').trim().toLowerCase();
  if (!USER_ID_RE.test(uid)) throw new BootstrapError('bad_user', 'Signed-in marketplace user required.');
  const cfg = issuerConfig(env);
  if (!issuerEnabled(env)) throw new BootstrapError('not_configured', 'Bootstrap pairing is not configured.');
  const body = JSON.stringify({ userId: uid });
  let res;
  try {
    res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...signRequest(cfg.secret, body) },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new BootstrapError('issuer_unreachable', 'Bootstrap issuer is unreachable.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new BootstrapError('rate_limited', 'Too many Control UI launches. Try again in a few minutes.');
  if (!res.ok || !data?.ok) throw new BootstrapError('issuer_error', `Bootstrap issuer refused (${res.status}).`);
  const scopes = Array.isArray(data.scopes) ? data.scopes : [];
  if (!TOKEN_RE.test(String(data.token || '')) || scopes.some((s) => FORBIDDEN.has(s)) || data.role !== 'operator') {
    throw new BootstrapError('issuer_bad_response', 'Bootstrap issuer returned an unexpected token.');
  }
  return { token: data.token, expiresAtMs: Number(data.expiresAtMs) || null, scopes };
}

/**
 * Control UI URL that pairs this browser with the bootstrap token. Only the
 * fragment carries credentials; no shared gateway token is included, so the
 * browser cannot fall back to the admin-scoped pairing request.
 */
function buildBootstrapUrl({ uiBaseUrl, userId, token, extra = {} }) {
  const base = String(uiBaseUrl || '').replace(/\/$/, '');
  if (!/^https:\/\//i.test(base) || !TOKEN_RE.test(String(token || ''))) return null;
  const hash = new URLSearchParams({
    gatewayUrl: base.replace(/^https:/i, 'wss:'),
    bootstrapToken: token,
    autoConnect: 'true',
    session: `market-${userId}`,
    audience: 'aimarkets',
    userId: String(userId),
  });
  for (const [k, v] of Object.entries(extra)) if (v) hash.set(k, String(v));
  return `${base}/#${hash.toString()}`;
}

module.exports = { requestBootstrapToken, buildBootstrapUrl, issuerEnabled, signRequest, BootstrapError, KEY_LABEL };
