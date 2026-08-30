const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { signToken, publicUser, authenticate } = require('../middleware/auth');
const { slugify } = require('../utils/serialize');
const { deleteCachePattern } = require('../utils/cache');

const router = express.Router();

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
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const { liftExpired, effectiveStatus, denyMessage } = require('../utils/moderation');
    await liftExpired(user, 'accountStatus');
    const status = effectiveStatus(user, 'accountStatus');
    if (status !== 'active') {
      return res.status(403).json({
        message: denyMessage(status),
        code: 'ACCOUNT_' + status.toUpperCase(),
        suspendedUntil: user.suspendedUntil,
      });
    }
    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
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
