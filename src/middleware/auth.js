const jwt = require('jsonwebtoken');
const config = require('../config/env');
const User = require('../models/User');
const { toClient } = require('../utils/serialize');
const { liftExpired, effectiveStatus, denyMessage } = require('../utils/moderation');

function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, email: user.email },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

function publicUser(user) {
  const u = toClient(user);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl || undefined,
    coverUrl: u.coverUrl || undefined,
    role: u.role,
    creatorSlug: u.creatorSlug || undefined,
    bio: u.bio || undefined,
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : new Date().toISOString(),
  };
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    let token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token && req.query?.access_token) {
      token = String(req.query.access_token).trim();
    }
    if (!token) {
      return res.status(401).json({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    await liftExpired(user, 'accountStatus');
    const status = effectiveStatus(user, 'accountStatus');
    if (status !== 'active') {
      return res.status(403).json({
        message: denyMessage(status),
        code: 'ACCOUNT_' + status.toUpperCase(),
        suspendedUntil: user.suspendedUntil,
      });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: 'Unauthorized' });
  }
}

function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return next();
  jwt.verify(token, config.jwtSecret, async (err, payload) => {
    if (err || !payload?.sub) return next();
    try {
      req.user = await User.findById(payload.sub);
    } catch {
      /* ignore */
    }
    next();
  });
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  };
}

module.exports = {
  signToken,
  publicUser,
  authenticate,
  optionalAuth,
  requireRoles,
};
