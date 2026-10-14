/**
 * Buyer-scoped OpenClaw device pairing approval.
 *
 * AI Markets runs ONE OpenClaw gateway for every buyer, so approving a pairing
 * request by id alone would let any buyer approve (or hijack) another buyer's
 * device. This service talks to the gateway's Admin HTTP RPC server-side only and
 * approves a request ONLY when:
 *   - the request id exists and is still pending,
 *   - it was opened from the buyer's own Control UI origin
 *     (https://<userId>.openclaw.aimarkets.vn),
 *   - it asks for the operator role and no admin/pairing scopes.
 * The gateway admin token never leaves the API.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const USER_ID_RE = /^[a-f0-9]{24}$/;
const DEFAULT_ALLOWED_SCOPES = ['operator.read', 'operator.write', 'operator.approvals', 'operator.talk.secrets'];

class PairingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function gatewayConfig(env = process.env) {
  return {
    url: String(env.OPENCLAW_GATEWAY_ADMIN_URL || env.OPENCLAW_GATEWAY_INTERNAL_URL || '').trim().replace(/\/$/, ''),
    token: String(env.OPENCLAW_GATEWAY_ADMIN_TOKEN || '').trim(),
    hostSuffix: String(env.OPENCLAW_AIMARKETS_HOST_SUFFIX || 'openclaw.aimarkets.vn').trim().toLowerCase(),
    allowedScopes: String(env.OPENCLAW_AIMARKETS_PAIRING_ALLOWED_SCOPES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function originHost(origin) {
  try {
    return new URL(String(origin || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Pure ownership/scope check, exported for tests. Returns null when allowed, else a PairingError. */
function checkPendingOwnership(pending, { userId, hostSuffix, allowedScopes }) {
  if (!pending) return new PairingError(404, 'not_found', 'No pending pairing request with that id. Open the Control UI from aimarkets.vn again and copy the new request id.');
  const expectedHost = `${userId}.${hostSuffix}`;
  if (originHost(pending.browserOrigin) !== expectedHost) {
    return new PairingError(403, 'not_owner', 'This pairing request was not opened from your own OpenClaw workspace.');
  }
  const roles = [pending.role, ...(Array.isArray(pending.roles) ? pending.roles : [])].filter(Boolean);
  if (roles.some((r) => r !== 'operator')) {
    return new PairingError(403, 'role_not_allowed', 'Only operator (Control UI) devices can be approved from AI Markets.');
  }
  const allowed = new Set(allowedScopes && allowedScopes.length ? allowedScopes : DEFAULT_ALLOWED_SCOPES);
  const extra = (Array.isArray(pending.scopes) ? pending.scopes : []).filter((s) => !allowed.has(s));
  if (extra.length) {
    return new PairingError(403, 'scope_not_allowed', `This device asks for scopes buyers cannot self-approve: ${extra.join(', ')}.`);
  }
  return null;
}

async function adminRpc({ url, token, fetchImpl }, method, params) {
  const res = await fetchImpl(`${url}/api/v1/admin/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ id: `aimarkets-${Date.now()}`, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new PairingError(502, 'gateway_error', `OpenClaw gateway rejected ${method}: ${data?.error?.message || res.status}`);
  }
  return data?.payload ?? data?.result ?? data;
}

/**
 * @param {{ userId: string, requestId: string, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} p
 */
async function approveOwnPairing({ userId, requestId, fetchImpl = fetch, env = process.env }) {
  const uid = String(userId || '').trim().toLowerCase();
  const rid = String(requestId || '').trim();
  if (!USER_ID_RE.test(uid)) throw new PairingError(400, 'bad_user', 'Signed-in marketplace user required.');
  if (!REQUEST_ID_RE.test(rid)) throw new PairingError(400, 'bad_request_id', 'Invalid pairing request id.');
  const cfg = gatewayConfig(env);
  if (!cfg.url || !cfg.token) {
    throw new PairingError(
      503,
      'not_configured',
      'Manual device pairing is not available yet. Relaunch OpenClaw from aimarkets.vn: your signed launch link pairs this browser automatically.'
    );
  }
  const rpc = { ...cfg, fetchImpl };
  let list;
  try {
    list = await adminRpc(rpc, 'device.pair.list', {});
  } catch (err) {
    if (err instanceof PairingError) throw err;
    throw new PairingError(502, 'gateway_unreachable', 'OpenClaw gateway is unreachable. Try again in a minute.');
  }
  const pending = (Array.isArray(list?.pending) ? list.pending : []).find((p) => p?.requestId === rid);
  const denied = checkPendingOwnership(pending, { userId: uid, hostSuffix: cfg.hostSuffix, allowedScopes: cfg.allowedScopes });
  if (denied) throw denied;
  await adminRpc(rpc, 'device.pair.approve', { requestId: rid });
  return { requestId: rid, deviceId: pending.deviceId, approved: true };
}

/**
 * Pending pairing requests that belong to this buyer (opened from their own
 * Control UI origin). Other buyers' requests are never returned.
 */
async function listOwnPairings({ userId, fetchImpl = fetch, env = process.env }) {
  const uid = String(userId || '').trim().toLowerCase();
  if (!USER_ID_RE.test(uid)) throw new PairingError(400, 'bad_user', 'Signed-in marketplace user required.');
  const cfg = gatewayConfig(env);
  if (!cfg.url || !cfg.token) {
    throw new PairingError(503, 'not_configured', 'Device pairing is not available yet. Relaunch OpenClaw from aimarkets.vn.');
  }
  let list;
  try {
    list = await adminRpc({ ...cfg, fetchImpl }, 'device.pair.list', {});
  } catch (err) {
    if (err instanceof PairingError) throw err;
    throw new PairingError(502, 'gateway_unreachable', 'OpenClaw gateway is unreachable. Try again in a minute.');
  }
  const expectedHost = `${uid}.${cfg.hostSuffix}`;
  return (Array.isArray(list?.pending) ? list.pending : [])
    .filter((p) => p && originHost(p.browserOrigin) === expectedHost && REQUEST_ID_RE.test(String(p.requestId || '')))
    .map((p) => {
      const denied = checkPendingOwnership(p, { userId: uid, hostSuffix: cfg.hostSuffix, allowedScopes: cfg.allowedScopes });
      return {
        requestId: p.requestId,
        deviceId: p.deviceId,
        role: p.role,
        scopes: Array.isArray(p.scopes) ? p.scopes : [],
        createdAt: p.createdAt || p.requestedAt || p.ts || null,
        approvable: !denied,
        ...(denied ? { reason: denied.code } : {}),
      };
    });
}

module.exports = { approveOwnPairing, listOwnPairings, checkPendingOwnership, PairingError, gatewayConfig, DEFAULT_ALLOWED_SCOPES };