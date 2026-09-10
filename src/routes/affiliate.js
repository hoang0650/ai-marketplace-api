const express = require('express');
const User = require('../models/User');
const { authenticate, invalidateAuthUserCache } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    const code =
      user.affiliateCode ||
      `PHAI-${String(user.name || 'USER').replace(/\s+/g, '').slice(0, 8).toUpperCase()}`;
    if (!user.affiliateCode) {
      user.affiliateCode = code;
      await user.save();
      await invalidateAuthUserCache(user._id);
    }
    res.json({
      code,
      clicks: user.affiliateClicks || 0,
      conversions: user.affiliateConversions || 0,
      earnings: user.affiliateEarnings || 0,
      currency: 'USD',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
