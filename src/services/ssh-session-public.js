const { hashSecret } = require('./ssh-sandbox');

/**
 * SSH passwords and private keys are shown once at generation.
 * Sessions persist a scrypt hash (passwords) or nothing (private keys).
 * /ssh/active never receives either secret.
 */

function passwordStorage(password) {
  return { passwordHash: hashSecret(password) };
}

function publicSshSession(session, now = new Date()) {
  const expiresAt = new Date(session.expiresAt);
  return {
    id: String(session._id || session.id || ''),
    agentId: session.agentId,
    authMethod: session.authMethod || (session.publicKey ? 'key' : 'password'),
    host: session.host,
    port: session.port,
    username: session.username,
    command: session.command,
    passwordShownOnce: true,
    expiresAt: expiresAt.toISOString(),
    expiresInMinutes: Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / 60000)),
  };
}

/** Fields to $unset when a legacy row still holds a secret. */
function legacySecretUnset(session) {
  const unset = {};
  if (session && session.password) unset.password = 1;
  if (session && session.privateKey) unset.privateKey = 1;
  return Object.keys(unset).length ? unset : null;
}

module.exports = { passwordStorage, publicSshSession, legacySecretUnset };
