const crypto = require('crypto');

/**
 * Per-buyer SSH sandboxes behind the dedicated SSH gateway (infra/ssh-gateway).
 *
 * The API never provisions host accounts. It issues a short-lived credential
 * bound to (buyer, agent), stores only a scrypt hash of the password, and the
 * gateway calls back into /v1/ssh-gateway/auth to verify each login. The
 * gateway then drops the connection into that buyer's own sandbox container.
 */

const USER_ID_RE = /^[a-f0-9]{24}$/;
const SSH_TTL_MS = 60 * 60 * 1000;

/** Agents that can use the sandbox gateway. `env` prefixes the per-agent env vars. */
const SANDBOX_AGENTS = Object.freeze({
  openclaw: { prefix: 'oc', env: 'OPENCLAW' },
  hermes: { prefix: 'hm', env: 'HERMES' },
  nanoclaw: { prefix: 'nc', env: 'NANOCLAW' },
  spacebot: { prefix: 'sb', env: 'SPACEBOT' },
});
const PREFIX_TO_AGENT = Object.fromEntries(Object.entries(SANDBOX_AGENTS).map(([id, a]) => [a.prefix, id]));

function isolationEnabled(agentId) {
  const agent = SANDBOX_AGENTS[agentId];
  return Boolean(agent) && process.env[`${agent.env}_SSH_PER_USER_ISOLATION`] === '1';
}

/** Deterministic login name: `<prefix>-<24 hex userId>`, e.g. `oc-65f0…`. */
function sandboxUsername(agentId, userId) {
  const agent = SANDBOX_AGENTS[agentId];
  const id = String(userId || '').toLowerCase();
  if (!agent || !USER_ID_RE.test(id)) throw new Error('invalid sandbox identity');
  return `${agent.prefix}-${id}`;
}

function parseSandboxUsername(username) {
  const m = /^([a-z]{2})-([a-f0-9]{24})$/.exec(String(username || ''));
  if (!m || !PREFIX_TO_AGENT[m[1]]) return null;
  return { agentId: PREFIX_TO_AGENT[m[1]], userId: m[2] };
}

function gatewayTarget(agentId) {
  const agent = SANDBOX_AGENTS[agentId];
  const host = String(
    process.env[`${agent.env}_SSH_GATEWAY_HOST`] || process.env.SSH_GATEWAY_HOST || 'ssh.aimarkets.vn'
  ).trim();
  const port = Number(process.env[`${agent.env}_SSH_GATEWAY_PORT`] || process.env.SSH_GATEWAY_PORT || 2422);
  return { host, port: Number.isInteger(port) && port > 0 && port !== 22 ? port : 2422 };
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifySecret(secret, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 20) return false;
  const salt = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(parts[3], 'base64url');
  if (!salt.length || expected.length !== SCRYPT.keylen) return false;
  const got = crypto.scryptSync(String(secret ?? ''), salt, expected.length, { N, r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(got, expected);
}

function randomPassword(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function buildSshCommand({ username, host, port }) {
  const portPart = port && Number(port) !== 22 ? ` -p ${port}` : '';
  return `ssh${portPart} ${username}@${host}`;
}

/**
 * Issue a fresh isolated credential for (user, agent). Revokes older ones.
 * Returns the plaintext password exactly once; only its hash is persisted.
 */
async function issueIsolatedSshSession({ SshSession, user, agentId, now = new Date() }) {
  const username = sandboxUsername(agentId, user?._id);
  const { host, port } = gatewayTarget(agentId);
  await SshSession.updateMany(
    { user: user._id, agentId, revokedAt: null },
    { $set: { revokedAt: now } }
  );
  const password = randomPassword();
  const expiresAt = new Date(now.getTime() + SSH_TTL_MS);
  const command = buildSshCommand({ username, host, port });
  const session = await SshSession.create({
    user: user._id,
    agentId,
    host,
    port,
    username,
    authMethod: 'password',
    passwordHash: hashSecret(password),
    isolated: true,
    command,
    expiresAt,
  });
  return { session, password, username, host, port, command, expiresAt };
}

/**
 * Gateway login check. Rejects unknown/expired/revoked credentials and agents
 * whose isolation flag is off. Returns the sandbox identity on success.
 */
async function verifyGatewayLogin({ SshSession, username, password, now = new Date() }) {
  const ident = parseSandboxUsername(username);
  if (!ident || !password || !isolationEnabled(ident.agentId)) return null;
  const session = await SshSession.findOne({
    user: ident.userId,
    agentId: ident.agentId,
    username,
    isolated: true,
    revokedAt: null,
    expiresAt: { $gt: now },
  })
    .select('+passwordHash')
    .sort({ createdAt: -1 })
    .lean();
  if (!session || !verifySecret(password, session.passwordHash)) return null;
  if (String(session.user).toLowerCase() !== ident.userId) return null;
  return {
    sessionId: String(session._id),
    userId: ident.userId,
    agentId: ident.agentId,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

/** Active isolated sessions; the gateway tears down any sandbox not in this list. */
async function listActiveSandboxSessions({ SshSession, now = new Date() }) {
  const agentIds = Object.keys(SANDBOX_AGENTS).filter(isolationEnabled);
  if (!agentIds.length) return [];
  const rows = await SshSession.find({
    agentId: { $in: agentIds },
    isolated: true,
    revokedAt: null,
    expiresAt: { $gt: now },
  })
    .select('user agentId expiresAt')
    .lean();
  return rows.map((r) => ({
    sessionId: String(r._id),
    userId: String(r.user).toLowerCase(),
    agentId: r.agentId,
    expiresAt: new Date(r.expiresAt).toISOString(),
  }));
}

module.exports = {
  SANDBOX_AGENTS,
  SSH_TTL_MS,
  isolationEnabled,
  sandboxUsername,
  parseSandboxUsername,
  gatewayTarget,
  hashSecret,
  verifySecret,
  buildSshCommand,
  issueIsolatedSshSession,
  verifyGatewayLogin,
  listActiveSandboxSessions,
};
