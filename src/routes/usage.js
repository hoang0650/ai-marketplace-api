const express = require('express');
const UsageStat = require('../models/UsageStat');
const { authenticate, requireRoles } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const creatorId = req.user.role === 'admin' && req.query.creatorId
      ? req.query.creatorId
      : req.user._id;
    const rows = await UsageStat.find({ creator: creatorId }).sort({ date: 1 }).lean();
    res.json(
      rows.map((r) => ({
        date: r.date,
        tokens: r.tokens || 0,
        gpuHours: r.gpuHours || 0,
        requests: r.requests || 0,
        revenue: r.revenue || 0,
      }))
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
