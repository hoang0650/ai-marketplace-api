const express = require('express');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  const code =
    req.user.affiliateCode ||
    `PHAI-${String(req.user.name || 'USER').replace(/\s+/g, '').slice(0, 8).toUpperCase()}`;
  if (!req.user.affiliateCode) {
    req.user.affiliateCode = code;
    await req.user.save();
  }
  res.json({
    code,
    clicks: req.user.affiliateClicks || 0,
    conversions: req.user.affiliateConversions || 0,
    earnings: req.user.affiliateEarnings || 0,
    currency: 'USD',
  });
});

module.exports = router;
