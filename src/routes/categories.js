const express = require('express');
const Product = require('../models/Product');
const { CATEGORY_META, PRODUCT_CATEGORIES } = require('../data/categories');
const { catalogVisibleFilter } = require('../utils/moderation');
const { cached, deleteCachePattern } = require('../utils/cache');

const router = express.Router();

const COUNTS_TTL = 60; // s — same cadence as product list cache

async function countsByCategory() {
  return cached('categories:counts', COUNTS_TTL, async () => {
    const visible = catalogVisibleFilter();
    const rows = await Product.aggregate([
      {
        $match: {
          category: { $in: PRODUCT_CATEGORIES },
          ...(visible.$and ? { $and: visible.$and } : visible),
        },
      },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);
    const map = Object.create(null);
    for (const row of rows) {
      map[String(row._id)] = Number(row.count) || 0;
    }
    return map;
  });
}

/** Drop category count cache when listings change (called from products routes). */
function invalidateCategoryCounts() {
  deleteCachePattern('categories:*').catch(() => {});
}

router.get('/', async (_req, res, next) => {
  try {
    const counts = await countsByCategory();
    res.json(
      CATEGORY_META.map((c) => ({
        ...c,
        productCount: counts[c.id] || 0,
      })),
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.invalidateCategoryCounts = invalidateCategoryCounts;
