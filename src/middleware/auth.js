const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const config = require('../config/env');
const User = require('../models/User');
const { toClient } = require('../utils/serialize');
const { getCache, setCache, deleteCache, isCacheAvailable, generateCacheKey } = require('../utils/cache');
const { liftExpired, effectiveStatus, denyMessage } = require('../utils/moderation');
const { normalizeRole, hasCapability } = require('../utils/roles');

const AUTH_USER_CACHE_TTL = 60 * 60;
const AUTH_SESSION_TTL = 30 * 24 * 60 * 60;
const AUTH_DB_TIMEOUT_MS = Number(process.env.AUTH_DB_TIMEOUT_MS) || 8000;
const REFRESH_COOKIE = 'refreshToken';
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function withHardTimeout(promise, ms, label = 'auth') {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    }),
  ]);
}

function authUserCacheKey(userId) {
  return generateCacheKey('auth', 'user', String(userId));
}

function authSessionCacheKey(userId) {
  return generateCacheKey('auth', 'session', String(userId));
}

function userIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.userId || payload.sub || '').trim();
}

function buildAccessTokenPayload(user) {
  const id = String(user._id);
  return {
    userId: id,
    sub: id,
    email: user.email,
    role: normalizeRole(user.role),
    status: user.accountStatus || 'active',
  };
}

const JWT_VERIFY = { algorithms: ['HS256'] };

function signAccessToken(user) {
  return jwt.sign(buildAccessTokenPayload(user), config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

function signRefreshToken(user) {
  return jwt.sign({ userId: String(user._id), tv: Number(user.tokenVersion) || 0 }, config.refreshTokenSecret, {
    expiresIn: config.refreshExpiresIn,
    algorithm: 'HS256',
  });
}

/** @deprecated Use signAccessToken — kept so existing callers keep working. */
function signToken(user) {
  return signAccessToken(user);
}

function getRefreshCookieOptions() {
  const sameSiteEnv = String(config.cookieSameSite || '').toLowerCase().trim();
  let sameSitePolicy;
  if (sameSiteEnv === 'strict' || sameSiteEnv === 'lax') {
    sameSitePolicy = sameSiteEnv;
  } else if (sameSiteEnv === 'none') {
    sameSitePolicy = config.isProduction ? 'none' : 'lax';
  } else {
    sameSitePolicy = 'lax';
  }
  return {
    httpOnly: true,
    secure: config.isProduction || sameSitePolicy === 'none',
    sameSite: sameSitePolicy,
    path: '/',
    maxAge: REFRESH_MAX_AGE_MS,
  };
}

function setRefreshCookie(res, refreshToken) {
  res.cookie(REFRESH_COOKIE, refreshToken, getRefreshCookieOptions());
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: getRefreshCookieOptions().sameSite,
    path: '/',
  });
}

function extractAccessToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const raw = header.slice(7).trim();
    if (raw && !raw.startsWith('mk_live_')) return raw;
  }
  if (req.query?.access_token) return String(req.query.access_token).trim();
  return '';
}

function extractRefreshToken(req) {
  const cookie = req.cookies?.[REFRESH_COOKIE];
  if (cookie) return String(cookie).trim();
  const body = req.body?.refreshToken;
  if (body) return String(body).trim();
  const header = req.headers['x-refresh-token'];
  if (header) return String(header).trim();
  return '';
}

function publicUser(user) {
  const u = toClient(user);
  const kycStatus = user?.kyc?.status || u?.kyc?.status || 'none';
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl || undefined,
    coverUrl: u.coverUrl || undefined,
    role: normalizeRole(u.role),
    adminPermissions: Array.isArray(u.adminPermissions) ? u.adminPermissions : [],
    creatorSlug: u.creatorSlug || undefined,
    bio: u.bio || undefined,
    kycStatus,
    hasPassword: !!(user?.passwordHash || user?.hasPassword),
    googleLinked: !!u.googleId,
    profile: {
      introLine: u.profile?.introLine || '',
      region: u.profile?.region || '',
      website: u.profile?.website || '',
      notifyLang: u.profile?.notifyLang || 'vi',
      socials: (u.profile?.socials || []).map((s) => ({ label: s.label || '', url: s.url || '' })),
    },
    preferences: {
      personalizeContent: !!u.preferences?.personalizeContent,
      personalizeAds: !!u.preferences?.personalizeAds,
      emailLoginAlerts: u.preferences?.emailLoginAlerts !== false,
    },
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : new Date().toISOString(),
  };
}

function cacheableUser(user) {
  const o = typeof user.toObject === 'function' ? user.toObject() : { ...user };
  o.hasPassword = !!(o.passwordHash || o.hasPassword);
  delete o.passwordHash;
  delete o.__v;
  if (o._id) o._id = String(o._id);
  if (Array.isArray(o.wishlist)) o.wishlist = o.wishlist.map((id) => String(id));
  if (o.createdAt) o.createdAt = new Date(o.createdAt).toISOString();
  if (o.updatedAt) o.updatedAt = new Date(o.updatedAt).toISOString();
  if (o.suspendedUntil) o.suspendedUntil = new Date(o.suspendedUntil).toISOString();
  return o;
}

function asReqUser(cached) {
  if (!cached) return null;
  const user = { ...cached };
  // Redis-cached users are plain JSON, so _id comes back as a string. Aggregation $match does not
  // cast like find() does, so a string id silently matched nothing (wallet balance read as 0).
  const rawId = user._id || user.id;
  user._id = typeof rawId === 'string' && mongoose.Types.ObjectId.isValid(rawId) ? new mongoose.Types.ObjectId(rawId) : rawId;
  if (user.suspendedUntil) user.suspendedUntil = new Date(user.suspendedUntil);
  if (user.createdAt) user.createdAt = new Date(user.createdAt);
  if (!Array.isArray(user.wishlist)) user.wishlist = [];
  return user;
}

function cacheNeedsMongoLift(cached) {
  if (!cached) return true;
  return effectiveStatus(asReqUser(cached), 'accountStatus') === 'active' &&
    (cached.accountStatus || 'active') === 'suspended';
}

async function invalidateAuthUserCache(userId) {
  if (!userId) return;
  const id = String(userId);
  await deleteCache(authUserCacheKey(id), authSessionCacheKey(id)).catch(() => {});
}

async function persistAuthCaches(user, meta = {}) {
  const id = String(user._id);
  const profile = cacheableUser(user);
  const session = {
    userId: id,
    email: user.email,
    role: normalizeRole(user.role),
    status: user.accountStatus || 'active',
    lastLogin: (meta.lastLogin || new Date()).toISOString(),
    lastLoginIp: meta.ip || null,
  };
  await Promise.all([
    setCache(authUserCacheKey(id), profile, AUTH_USER_CACHE_TTL),
    setCache(authSessionCacheKey(id), session, AUTH_SESSION_TTL),
  ]).catch(() => {});
}

async function loadActiveUser(userId, { allowCache = true } = {}) {
  if (!userId) return null;
  const id = String(userId);

  if (allowCache && isCacheAvailable()) {
    const cached = await getCache(authUserCacheKey(id));
    if (cached && (cached._id || cached.id) && !cacheNeedsMongoLift(cached)) {
      return asReqUser(cached);
    }
  }

  const user = await withHardTimeout(User.findById(id), AUTH_DB_TIMEOUT_MS, 'auth-db');
  if (user) {
    setCache(authUserCacheKey(id), cacheableUser(user), AUTH_USER_CACHE_TTL).catch(() => {});
  }
  return user;
}

async function requireAuthSession(userId) {
  if (!userId || !isCacheAvailable()) return true;
  try {
    const session = await getCache(authSessionCacheKey(String(userId)));
    // Missing key is not a logout: Redis writes are best-effort and can drop
    // on timeout. A valid refresh JWT + cookie is enough to continue.
    if (!session) return true;
    return String(session.userId) === String(userId);
  } catch {
    return true;
  }
}

async function getAuthSession(userId) {
  if (!userId || !isCacheAvailable()) return null;
  return getCache(authSessionCacheKey(String(userId))).catch(() => null);
}

function issueAuthTokens(user) {
  return {
    token: signAccessToken(user),
    refreshToken: signRefreshToken(user),
  };
}

async function attachAuthSession(res, user, meta = {}) {
  const tokens = issueAuthTokens(user);
  setRefreshCookie(res, tokens.refreshToken);
  await persistAuthCaches(user, meta);
  return {
    token: tokens.token,
    refreshToken: tokens.refreshToken,
    user: publicUser(user),
  };
}

async function authenticateToken(req, res, next) {
  try {
    const token = extractAccessToken(req);
    if (!token) {
      return res.status(401).json({
        message: 'Không tìm thấy token xác thực',
        code: 'UNAUTHORIZED',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret, JWT_VERIFY);
    } catch (err) {
      return res.status(401).json({
        message: err.name === 'TokenExpiredError' ? 'Token đã hết hạn' : 'Token không hợp lệ',
        code: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED',
      });
    }

    const userId = userIdFromPayload(decoded);
    if (!userId) {
      return res.status(401).json({ message: 'Token không hợp lệ', code: 'UNAUTHORIZED' });
    }

    let user;
    try {
      user = await loadActiveUser(userId);
    } catch (err) {
      if (String(err.message || '').includes('timeout')) {
        return res.status(503).json({ message: 'Dịch vụ xác thực tạm thời quá tải', code: 'AUTH_TIMEOUT' });
      }
      throw err;
    }

    if (!user) {
      return res.status(401).json({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    if (typeof user.save === 'function') {
      await liftExpired(user, 'accountStatus');
    }
    const status = effectiveStatus(user, 'accountStatus');
    if (status !== 'active') {
      return res.status(403).json({
        message: denyMessage(status),
        code: 'ACCOUNT_' + status.toUpperCase(),
        suspendedUntil: user.suspendedUntil,
      });
    }

    req.user = user;
    req.authPayload = decoded;
    next();
  } catch {
    return res.status(401).json({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
  }
}

const authenticate = authenticateToken;

function optionalAuth(req, _res, next) {
  const token = extractAccessToken(req);
  if (!token) return next();
  jwt.verify(token, config.jwtSecret, JWT_VERIFY, async (err, payload) => {
    if (err) return next();
    const userId = userIdFromPayload(payload);
    if (!userId) return next();
    try {
      req.user = await loadActiveUser(userId);
    } catch {
      /* ignore */
    }
    next();
  });
}

function requireRoles(...roles) {
  const allowed = roles.flat().map(normalizeRole);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const role = normalizeRole(req.user.role);
    if (role !== 'admin' && !allowed.includes(role)) {
      return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' });
    }
    next();
  };
}

/** Admin, or a staff account granted `permission` (least privilege, see utils/roles.js). */
function requireAdminPermission(permission) {
  const { hasAdminPermission } = require('../utils/roles');
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (!hasAdminPermission(req.user, permission)) return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' });
    next();
  };
}

/** Gate by capability name (see utils/roles.js). Admin always passes. */
function requireCapability(capability) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    if (!hasCapability(req.user, capability)) {
      return res.status(403).json({
        message: 'Forbidden',
        code: 'FORBIDDEN',
        capability,
      });
    }
    next();
  };
}

const authorizeRoles = (allowedRoles) => requireRoles(...(Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]));

module.exports = {
  asReqUser,
  AUTH_USER_CACHE_TTL,
  AUTH_SESSION_TTL,
  REFRESH_COOKIE,
  buildAccessTokenPayload,
  userIdFromPayload,
  signAccessToken,
  signRefreshToken,
  signToken,
  getRefreshCookieOptions,
  setRefreshCookie,
  clearRefreshCookie,
  extractAccessToken,
  extractRefreshToken,
  publicUser,
  requireAdminPermission,
  invalidateAuthUserCache,
  persistAuthCaches,
  requireAuthSession,
  getAuthSession,
  loadActiveUser,
  issueAuthTokens,
  attachAuthSession,
  authenticateToken,
  authenticate,
  optionalAuth,
  requireRoles,
  requireCapability,
  authorizeRoles,
  JWT_VERIFY,
};
