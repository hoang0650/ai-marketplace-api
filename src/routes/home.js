const express = require('express');
const Product = require('../models/Product');
const User = require('../models/User');
const Order = require('../models/Order');
const UsageStat = require('../models/UsageStat');
const { mapProduct } = require('../utils/mappers');
const { cached } = require('../utils/cache');
const { PRODUCT_CATEGORIES } = require('../data/categories');
const { catalogVisibleFilter } = require('../utils/moderation');

const router = express.Router();

const HOME_TTL = 60;
const RAIL = 8;
const SHOP_LIMIT = 8;

function catalogFilter() {
  return {
    category: { $in: PRODUCT_CATEGORIES },
    ...catalogVisibleFilter(),
  };
}

function roundMoney(n) {
  const x = Number(n) || 0;
  return Math.round(x * 100) / 100;
}

async function buildHomeFeed() {
  const filter = catalogFilter();

  const [newArrivals, promoted, bestsellers, orderRev, usageRev, productStats] = await Promise.all([
    Product.find(filter).sort({ publishedAt: -1, createdAt: -1 }).limit(RAIL).lean(),
    Product.find({ ...filter, featured: true }).sort({ publishedAt: -1 }).limit(RAIL).lean(),
    Product.find(filter).sort({ salesCount: -1, rating: -1, publishedAt: -1 }).limit(RAIL).lean(),
    Order.aggregate([
      { $match: { status: 'paid' } },
      {
        $group: {
          _id: '$seller',
          revenue: { $sum: { $ifNull: ['$amount', 0] } },
          orders: { $sum: 1 },
        },
      },
    ]),
    UsageStat.aggregate([
      { $group: { _id: '$creator', revenue: { $sum: { $ifNull: ['$revenue', 0] } } } },
    ]),
    Product.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$creator',
          productCount: { $sum: 1 },
          totalSales: { $sum: { $ifNull: ['$salesCount', 0] } },
          rating: { $avg: { $ifNull: ['$rating', 0] } },
          coverUrl: { $first: '$coverUrl' },
          creatorSlug: { $first: '$creatorSlug' },
          creatorName: { $first: '$creatorName' },
        },
      },
    ]),
  ]);

  const revenueBySeller = new Map();
  for (const row of orderRev) {
    if (!row?._id) continue;
    revenueBySeller.set(String(row._id), {
      revenue: Number(row.revenue) || 0,
      orders: Number(row.orders) || 0,
    });
  }
  for (const row of usageRev) {
    if (!row?._id) continue;
    const id = String(row._id);
    const prev = revenueBySeller.get(id) || { revenue: 0, orders: 0 };
    prev.revenue += Number(row.revenue) || 0;
    revenueBySeller.set(id, prev);
  }

  const statsByCreator = new Map(
    productStats.filter((s) => s?._id).map((s) => [String(s._id), s]),
  );
  const creatorIds = productStats.map((s) => s._id).filter(Boolean);

  const users = creatorIds.length
    ? await User.find({
        _id: { $in: creatorIds },
        creatorSlug: { $exists: true, $ne: '' },
      })
        .select('name avatarUrl coverUrl bio verified creatorSlug')
        .lean()
    : [];

  const shops = users
    .map((u) => {
      const id = String(u._id);
      const stats = statsByCreator.get(id);
      const money = revenueBySeller.get(id);
      return {
        id,
        slug: u.creatorSlug,
        name: u.name,
        bio: u.bio || '',
        avatarUrl: u.avatarUrl || '',
        coverUrl: u.coverUrl || stats?.coverUrl || '',
        verified: !!u.verified,
        productCount: Number(stats?.productCount) || 0,
        rating: Math.round((Number(stats?.rating) || 0) * 10) / 10,
        totalSales: Number(stats?.totalSales) || 0,
        revenue: roundMoney(money?.revenue || 0),
      };
    })
    .filter((s) => s.slug && s.productCount > 0)
    .sort(
      (a, b) =>
        b.revenue - a.revenue ||
        b.totalSales - a.totalSales ||
        b.productCount - a.productCount,
    )
    .slice(0, SHOP_LIMIT);

  return {
    shops,
    newArrivals: newArrivals.map((p) => mapProduct(p)),
    promoted: promoted.map((p) => mapProduct(p)),
    bestsellers: bestsellers.map((p) => mapProduct(p)),
  };
}

router.get('/', async (_req, res, next) => {
  try {
    const result = await cached('home:feed:v1', HOME_TTL, buildHomeFeed);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.buildHomeFeed = buildHomeFeed;
