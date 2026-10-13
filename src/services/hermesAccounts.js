const crypto = require('crypto');
const HermesAccount = require('../models/HermesAccount');
const HermesLoginTicket = require('../models/HermesLoginTicket');

const TICKET_TTL_MS = Math.max(15, Number(process.env.HERMES_LOGIN_TICKET_TTL_SECONDS || 120) || 120) * 1000;
const TICKET_RE = /^[A-Za-z0-9_-]{32,128}$/;

function hashTicket(ticket) {
  return crypto.createHash('sha256').update(String(ticket)).digest('hex');
}

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

/** Mint a single-use Launch ticket (raw value returned once; only its hash is stored). */
async function issueHermesLoginTicket(userId, { now = Date.now() } = {}) {
  const id = String(userId || '').trim();
  if (!USER_ID_RE.test(id)) throw new Error('Invalid marketplace user id');
  const ticket = crypto.randomBytes(32).toString('base64url');
  await HermesLoginTicket.create({ hash: hashTicket(ticket), user: id, expiresAt: new Date(now + TICKET_TTL_MS) });
  return ticket;
}

/** Atomically consume a ticket; returns the same shape as verifyHermesCredentials or null. */
async function consumeHermesLoginTicket(ticket, { now = new Date() } = {}) {
  const t = String(ticket || '').trim();
  if (!TICKET_RE.test(t)) return null;
  const row = await HermesLoginTicket.findOneAndDelete({ hash: hashTicket(t) }).lean();
  if (!row || !row.expiresAt || new Date(row.expiresAt).getTime() <= now.getTime()) return null;
  const account = await HermesAccount.findOne({ user: row.user }).lean();
  if (!account) return null;
  return { userId: String(account.user), username: account.username, profile: account.profile };
}

module.exports = {
  hashTicket,
  issueHermesLoginTicket,
  consumeHermesLoginTicket,
  profileForUserId,
  usernameForUser,
  ensureHermesAccount,
  verifyHermesCredentials,
};
