const crypto = require('crypto');
const HermesAccount = require('../models/HermesAccount');

const USER_ID_RE = /^[a-f0-9]{24}$/i;

function profileForUserId(userId) {
  const id = String(userId || '').trim().toLowerCase();
  if (!USER_ID_RE.test(id)) return '';
  return `market-${id}`;
}

function usernameForUser(user) {
  const id = String(user?._id || user?.id || '').trim().toLowerCase();
  const emailLocal = String(user?.email || '')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12);
  const short = id.slice(-10);
  return `buyer-${emailLocal || 'u'}-${short}`.slice(0, 32);
}

function randomPassword(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Create or return existing Hermes dashboard account for a marketplace buyer.
 */
async function ensureHermesAccount(user) {
  const userId = String(user?._id || user?.id || '').trim();
  if (!USER_ID_RE.test(userId)) {
    throw new Error('Invalid marketplace user id');
  }

  let account = await HermesAccount.findOne({ user: userId });
  if (account) return account;

  const profile = profileForUserId(userId);
  let username = usernameForUser(user);
  // Rare collision on username — append more id
  for (let i = 0; i < 5; i += 1) {
    try {
      account = await HermesAccount.create({
        user: userId,
        username,
        password: randomPassword(),
        profile,
      });
      return account;
    } catch (err) {
      if (err?.code === 11000) {
        username = `${usernameForUser(user)}${i + 1}`;
        const existing = await HermesAccount.findOne({ user: userId });
        if (existing) return existing;
        continue;
      }
      throw err;
    }
  }
  throw new Error('Failed to allocate Hermes username');
}

async function verifyHermesCredentials(username, password) {
  const u = String(username || '').trim().toLowerCase();
  const p = String(password || '');
  if (!u || !p) return null;
  const account = await HermesAccount.findOne({ username: u });
  if (!account) {
    // timing stand-in
    crypto.timingSafeEqual(Buffer.from(p), Buffer.from(p));
    return null;
  }
  const a = Buffer.from(String(account.password));
  const b = Buffer.from(p);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return {
    userId: String(account.user),
    username: account.username,
    profile: account.profile,
  };
}

module.exports = {
  profileForUserId,
  usernameForUser,
  ensureHermesAccount,
  verifyHermesCredentials,
};
