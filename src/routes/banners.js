const express = require('express');
const Banner = require('../models/Banner');
const { cached } = require('../utils/cache');

const router = express.Router();
const TTL = 60;

function mapBanner(doc) {
  const b = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
  return {
    id: String(b.id || b._id),
    title: b.title,
    subtitle: b.subtitle || '',
    imageUrl: b.imageUrl,
    linkType: b.linkType,
    linkValue: b.linkValue || '',
    slot: b.slot,
    sortOrder: Number(b.sortOrder) || 0,
  };
}

function activeWindowFilter(now = new Date()) {
  return {
    active: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
    ],
  };
}

/** GET /v1/banners?slot=home_hero|offers|partners */
router.get('/', async (req, res, next) => {
  try {
    const slot = String(req.query.slot || '').trim();
    const cacheKey = slot ? `banners:slot:${slot}` : 'banners:all';
    const rows = await cached(cacheKey, TTL, async () => {
      const filter = activeWindowFilter();
      if (slot) filter.slot = slot;
      return Banner.find(filter).sort({ sortOrder: 1, createdAt: -1 }).lean();
    });
    res.json(rows.map(mapBanner));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
