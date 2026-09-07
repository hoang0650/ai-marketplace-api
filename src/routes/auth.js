const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const config = require('../config/env');
const { signToken, publicUser, authenticate } = require('../middleware/auth');
const { slugify } = require('../utils/serialize');
const { deleteCachePattern } = require('../utils/cache');
const {
  getGoogleClientId,
  verifyGoogleIdToken,
  verifyGoogleAuthCode,
  googleCallbackUrl,
  normalizeReturnTo,
} = require('../config/googleAuth');
const { liftExpired, effectiveStatus, denyMessage } = require('../utils/moderation');

const router = express.Router();

async function assertAccountActive(user) {
  await liftExpired(user, 'accountStatus');
  const status = effectiveStatus(user, 'accountStatus');
  if (status !== 'active') {
    const err = new Error(denyMessage(status));
    err.statusCode = 403;
    err.code = 'ACCOUNT_' + status.toUpperCase();
    err.suspendedUntil = user.suspendedUntil;
    throw err;
  }
}

async function findOrCreateGoogleUser(profile) {
  let user = await User.findOne({ googleId: profile.googleId });
  if (user) return user;

  user = await User.findOne({ email: profile.email });
  if (user) {
    if (user.googleId && user.googleId !== profile.googleId) {
      const err = new Error('Email đã liên kết với tài khoản Google khác');
      err.statusCode = 409;
      throw err;
    }
    user.googleId = profile.googleId;
    if (user.authProvider === 'local') user.authProvider = 'google';
    if (profile.avatar && !user.avatarUrl) user.avatarUrl = profile.avatar;
    if (profile.fullName && !user.name) user.name = profile.fullName;
    await user.save();
    return user;
  }

  const name = profile.fullName || profile.email.split('@')[0];
  return User.create({
    email: profile.email,
    name,
    passwordHash: '',
    googleId: profile.googleId,
    authProvider: 'google',
    avatarUrl:
      profile.avatar ||
      `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(profile.email)}`,
    affiliateCode: `PHAI-${slugify(name).slice(0, 8).toUpperCase() || 'USER'}`,
  });
}

router.post('/register', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim();
    const password = String(req.body?.password || '');
    const asCreator = !!req.body?.asCreator;

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
    if (!emailOk) {
      return res.status(400).json({ message: 'Invalid email address' });
    }
    if (!name || name.length > 120) {
      return res.status(400).json({ message: 'Name is required (max 120 characters)' });
    }
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ message: 'Password must be 8-128 characters' });
    }

    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let creatorSlug;
    if (asCreator) {
      creatorSlug = slugify(name) || `creator-${Date.now()}`;
      const clash = await User.findOne({ creatorSlug });
      if (clash) creatorSlug = `${creatorSlug}-${Date.now().toString(36)}`;
    }

    const user = await User.create({
      email,
      name,
      passwordHash,
      role: asCreator ? 'creator' : 'buyer',
      creatorSlug,
      avatarUrl: `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(email)}`,
      affiliateCode: `PHAI-${slugify(name).slice(0, 8).toUpperCase() || 'USER'}`,
    });

    if (asCreator) {
      // New creator appears in /creators listings.
      deleteCachePattern('creators:*').catch(() => {});
    }

    const token = signToken(user);
    return res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    if (!user.passwordHash) {
      return res.status(400).json({
        message: 'Tài khoản đăng nhập bằng Google. Vui lòng dùng nút Đăng nhập với Google.',
        code: 'USE_GOOGLE',
      });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    await assertAccountActive(user);
    return res.json({ token: signToken(user), user: publicUser(user) });  } catch (err) {
    next(err);
  }
});

router.get('/google/config', (_req, res) => {
  const clientId = getGoogleClientId();
  res.json({
    enabled: !!clientId,
    clientId: clientId || undefined,
    mode: 'redirect',
  });
});

router.get('/google/start', (req, res) => {
  const clientId = getGoogleClientId();
  if (!clientId) {
    return res.status(503).json({ message: 'Google Sign-In chưa được cấu hình trên máy chủ' });
  }
  const refererOrigin = (() => {
    try {
      return req.get('referer') ? new URL(req.get('referer')).origin : '';
    } catch {
      return '';
    }
  })();
  const { origin, path } = normalizeReturnTo(String(req.query.returnTo || ''), refererOrigin || config.frontendUrl);
  const redirectUri = googleCallbackUrl(req);
  const state = jwt.sign({ o: origin, p: path }, config.jwtSecret, { expiresIn: '10m' });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('access_type', 'online');
  return res.redirect(url.toString());
});

router.get('/google/callback', async (req, res, next) => {
  const fallback = String(config.frontendUrl || 'https://aimarkets.vn').replace(/\/$/, '');
  const fail = (origin, message) => {
    const o = origin || fallback;
    const q = new URLSearchParams({ google: 'error', message: String(message || 'Google sign-in failed').slice(0, 180) });
    return res.redirect(`${o}/auth/login?${q.toString()}`);
  };
  try {
    if (req.query.error) {
      return fail(fallback, req.query.error_description || req.query.error);
    }
    const state = String(req.query.state || '');
    const code = String(req.query.code || '');
    if (!state || !code) {
      return fail(fallback, 'Thiếu mã Google');
    }
    let payload;
    try {
      payload = jwt.verify(state, config.jwtSecret);
    } catch {
      return fail(fallback, 'Phiên Google hết hạn, thử lại');
    }
    const origin = String(payload.o || fallback).replace(/\/$/, '');
    const nextPath = String(payload.p || '/').startsWith('/') ? String(payload.p) : '/';
    const redirectUri = googleCallbackUrl(req);
    const profile = await verifyGoogleAuthCode(code, redirectUri);
    const user = await findOrCreateGoogleUser(profile);
    await assertAccountActive(user);
    const token = signToken(user);
    const q = new URLSearchParams({ token, next: nextPath });
    return res.redirect(`${origin}/auth/google/callback?${q.toString()}`);
  } catch (err) {
    console.error('[google-callback]', err?.message || err);
    return fail(fallback, err.message || 'Đăng nhập Google thất bại');
  }
});

router.post('/google/login', async (req, res, next) => {
  try {
    const clientId = getGoogleClientId();
    if (!clientId) {
      return res.status(503).json({ message: 'Google Sign-In chưa được cấu hình trên máy chủ' });
    }

    const { idToken, code, redirectUri } = req.body || {};
    let profile;
    if (idToken) {
      profile = await verifyGoogleIdToken(idToken);
    } else if (code) {
      profile = await verifyGoogleAuthCode(code, redirectUri || 'postmessage');
    } else {
      return res.status(400).json({ message: 'Thiếu idToken hoặc code Google' });
    }

    const user = await findOrCreateGoogleUser(profile);
    await assertAccountActive(user);
    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        message: err.message,
        code: err.code,
        suspendedUntil: err.suspendedUntil,
      });
    }
    next(err);
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json(publicUser(req.user));
});

router.patch('/me', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });

    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name || name.length > 120) {
        return res.status(400).json({ message: 'Name is required (max 120 characters)' });
      }
      user.name = name;
    }
    if (req.body?.bio !== undefined) {
      user.bio = String(req.body.bio || '').slice(0, 2000);
    }
    if (req.body?.avatarUrl !== undefined) {
      user.avatarUrl = String(req.body.avatarUrl || '').slice(0, 2000);
    }
    if (req.body?.coverUrl !== undefined) {
      user.coverUrl = String(req.body.coverUrl || '').slice(0, 2000);
    }

    await user.save();
    deleteCachePattern('creators:*').catch(() => {});
    return res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
