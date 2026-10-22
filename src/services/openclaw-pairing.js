/**
 * Buyer-scoped OpenClaw device pairing approval.
 *
 * AI Markets runs ONE OpenClaw gateway for every buyer, so approving a pairing
 * request by id alone would let any buyer approve (or hijack) another buyer's
 * device. This service talks to the gateway's Admin HTTP RPC server-side only and
 * approves a request ONLY when:
 *   - the request id exists and is still pending,
 *   - it was opened from the buyer's own Control UI origin
 *     (https://<userId>.openclaw.aimarkets.vn), or, on gateways >= 2026.10.5
 *     that no longer record browserOrigin for Control UI requests, it is a
 *     fresh Control UI request from the same public IP as the signed-in buyer,
 *   - it asks for the operator role and no admin/pairing scopes.
 * The gateway admin token never leaves the API.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const USER_ID_RE = /^[a-f0-9]{24}$/;
// Standard (non-admin) Control UI access. Matches OpenClaw's own non-admin operator set.
const DEFAULT_ALLOWED_SCOPES = ['operator.read', 'operator.write', 'operator.approvals', 'operator.questions', 'operator.talk.secrets'];
// Gateway-wide powers: admin = config/exec approvals/node bindings for EVERY workspace on
// the shared gateway; pairing = approve any device. Buyers never get these.
const PRIVILEGED_SCOPES = new Set(['operator.admin', 'operator.pairing']);

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
    // Gateway operators (AI Markets staff who own the shared gateway) may self-approve
    // the Control UI's full default scope set. Comma-separated marketplace user ids.
    ownerUserIds: String(env.OPENCLAW_PAIRING_OWNER_USER_IDS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => USER_ID_RE.test(s)),
  };
}

function originHost(origin) {
  try {
    return new URL(String(origin || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const CONTROL_UI_CLIENT_IDS = new Set(['openclaw-control-ui', 'control-ui']);
const IP_MATCH_MAX_AGE_MS = 15 * 60 * 1000;

function normalizeIp(ip) {
  let v = String(ip || '').trim().toLowerCase();
  if (v.startsWith('::ffff:')) v = v.slice(7);
  return v;
}

function pendingCreatedMs(p) {
  const raw = p?.createdAtMs ?? p?.requestedAtMs ?? p?.ts ?? p?.createdAt ?? p?.requestedAt;
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pending requests from either gateway format: { pending: [...] } (all versions),
 * a bare array, or { pendingById: { id: req } }.
 */
function pendingOf(list) {
  if (Array.isArray(list)) return list;
  if (Array.isArray(list?.pending)) return list.pending;
  if (list?.pendingById && typeof list.pendingById === 'object') {
    return Object.entries(list.pendingById).map(([id, p]) => ({ requestId: id, ...p }));
  }
  return [];
}

/**
 * Does this pending request belong to the buyer? Old gateways record the Control UI
 * origin (browserOrigin); OpenClaw 2026.10.5+ only records it for browser-copilot
 * extensions, so Control UI requests carry just remoteIp/clientId. In that case the
 * request must come from the Control UI, from the buyer's current public IP, recently.
 */
function isOwnPending(p, { userId, hostSuffix, clientIp, nowMs = Date.now() }) {
  if (!p) return false;
  if (p.browserOrigin) return originHost(p.browserOrigin) === `${userId}.${hostSuffix}`;
  const ip = normalizeIp(clientIp);
  if (!ip || normalizeIp(p.remoteIp) !== ip) return false;
  if (p.clientId && !CONTROL_UI_CLIENT_IDS.has(String(p.clientId))) return false;
  const created = pendingCreatedMs(p);
  if (created != null && nowMs - created > IP_MATCH_MAX_AGE_MS) return false;
  return true;
}

/** Pure ownership/scope check, exported for tests. Returns null when allowed, else a PairingError. */
function checkPendingOwnership(pending, { userId, hostSuffix, allowedScopes, ownerUserIds, clientIp, nowMs }) {
  if (!pending) {
    return new PairingError(
      404,
      'not_found',
      'No pending pairing request from your workspace. Open the Control UI from aimarkets.vn, then click Approve on the setup page. The gateway token is not a request id.',
    );
  }
  if (!isOwnPending(pending, { userId, hostSuffix, clientIp, nowMs })) {
    return new PairingError(403, 'not_owner', 'This pairing request was not opened from your own OpenClaw workspace.');
  }
  const roles = [pending.role, ...(Array.isArray(pending.roles) ? pending.roles : [])].filter(Boolean);
  if (roles.some((r) => r !== 'operator')) {
    return new PairingError(403, 'role_not_allowed', 'Only operator (Control UI) devices can be approved from AI Markets.');
  }
  if (Array.isArray(ownerUserIds) && ownerUserIds.includes(userId)) return null;
  const allowed = new Set(allowedScopes && allowedScopes.length ? allowedScopes : DEFAULT_ALLOWED_SCOPES);
  const extra = (Array.isArray(pending.scopes) ? pending.scopes : []).filter((s) => !allowed.has(s));
  if (extra.length) {
    const privileged = extra.filter((s) => PRIVILEGED_SCOPES.has(s));
    const err = new PairingError(
      403,
      'scope_not_allowed',
      privileged.length
        ? `Not allowed: this browser asked for gateway admin permissions (${privileged.join(', ')}). ` +
            'Your OpenClaw workspace runs on a shared AI Markets gateway, where those permissions would control every workspace, ' +
            'so they cannot be approved from AI Markets. Standard access (chat, read/write, approvals) is unaffected. ' +
            'Contact AI Markets support if you need this device paired.'
        : `Not allowed: this browser asked for permissions that cannot be self-approved (${extra.join(', ')}). Contact AI Markets support.`,
    );
    err.disallowedScopes = extra;
    return err;
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
function ownApprovable(list, uid, cfg, clientIp) {
  return pendingOf(list).filter(
    (p) => !checkPendingOwnership(p, { userId: uid, hostSuffix: cfg.hostSuffix, allowedScopes: cfg.allowedScopes, ownerUserIds: cfg.ownerUserIds, clientIp }),
  );
}

async function loadPairingList(cfg, fetchImpl) {
  try {
    return await adminRpc({ ...cfg, fetchImpl }, 'device.pair.list', {});
  } catch (err) {
    if (err instanceof PairingError) throw err;
    throw new PairingError(502, 'gateway_unreachable', 'OpenClaw gateway is unreachable. Try again in a minute.');
  }
}

async function approveOwnPairing({ userId, requestId, clientIp, fetchImpl = fetch, env = process.env }) {
  const uid = String(userId || '').trim().toLowerCase();
  const rid = String(requestId || '').trim();
  if (!USER_ID_RE.test(uid)) throw new PairingError(400, 'bad_user', 'Signed-in marketplace user required.');
  if (rid && !REQUEST_ID_RE.test(rid)) throw new PairingError(400, 'bad_request_id', 'Invalid pairing request id.');
  const cfg = gatewayConfig(env);
  if (!cfg.url || !cfg.token) {
    throw new PairingError(
      503,
      'not_configured',
      'Device pairing is not available yet. Relaunch OpenClaw from aimarkets.vn: your signed launch link pairs this browser automatically.'
    );
  }
  const list = await loadPairingList(cfg, fetchImpl);
  const pending = rid
    ? pendingOf(list).find((p) => p?.requestId === rid)
    : ownApprovable(list, uid, cfg, clientIp).at(-1);
  const denied = checkPendingOwnership(pending, { userId: uid, hostSuffix: cfg.hostSuffix, allowedScopes: cfg.allowedScopes, ownerUserIds: cfg.ownerUserIds, clientIp });
  if (denied) throw denied;
  const approvedId = pending.requestId;
  await adminRpc({ ...cfg, fetchImpl }, 'device.pair.approve', { requestId: approvedId });
  return { requestId: approvedId, deviceId: pending.deviceId, approved: true };
}

/**
 * Pending pairing requests that belong to this buyer (opened from their own
 * Control UI origin). Other buyers' requests are never returned.
 */
async function listOwnPairings({ userId, clientIp, fetchImpl = fetch, env = process.env }) {
  const uid = String(userId || '').trim().toLowerCase();
  if (!USER_ID_RE.test(uid)) throw new PairingError(400, 'bad_user', 'Signed-in marketplace user required.');
  const cfg = gatewayConfig(env);
  if (!cfg.url || !cfg.token) {
    throw new PairingError(503, 'not_configured', 'Device pairing is not available yet. Relaunch OpenClaw from aimarkets.vn.');
  }
  const list = await loadPairingList(cfg, fetchImpl);
  return pendingOf(list)
    .filter((p) => isOwnPending(p, { userId: uid, hostSuffix: cfg.hostSuffix, clientIp }) && REQUEST_ID_RE.test(String(p.requestId || '')))
    .map((p) => {
      const denied = checkPendingOwnership(p, { userId: uid, hostSuffix: cfg.hostSuffix, allowedScopes: cfg.allowedScopes, ownerUserIds: cfg.ownerUserIds, clientIp });
      return {
        requestId: p.requestId,
        deviceId: p.deviceId,
        role: p.role,
        scopes: Array.isArray(p.scopes) ? p.scopes : [],
        createdAt: p.createdAt || p.requestedAt || p.ts || p.createdAtMs || null,
        approvable: !denied,
        ...(denied ? { reason: denied.code, message: denied.message } : {}),
      };
    });
}

module.exports = { approveOwnPairing, listOwnPairings, checkPendingOwnership, PairingError, gatewayConfig, DEFAULT_ALLOWED_SCOPES };