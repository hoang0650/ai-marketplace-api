const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Review = require('../models/Review');
const WalletTx = require('../models/WalletTx');
const Notification = require('../models/Notification');
const { authenticate, requireRoles, invalidateAuthUserCache } = require('../middleware/auth');
const { PLATFORM_COMMISSION_RATE } = require('../utils/platform');
const { applyStatus, STATUSES, effectiveStatus } = require('../utils/moderation');
const { deleteCachePattern } = require('../utils/cache');
const { mapProduct, mapOrder } = require('../utils/mappers');
const { resolveOrderDispute } = require('../utils/resolve-order-dispute');
const { adminDailySeries, adminSeries } = require('../utils/admin-series');

const router = express.Router();

router.get('/overview', authenticate, requireRoles('admin'), async (_req, res, next) => {
  try {
    const [
      users,
      products,
      orders,
      reviews,
      creators,
      revenueAgg,
      shopAgg,
      depositAgg,
      usersList,
      productsList,
      series,
    ] = await Promise.all([
      User.countDocuments(),
      Product.countDocuments(),
      Order.countDocuments(),
      Review.countDocuments(),
      User.countDocuments({ role: { $in: ['seller', 'talent', 'freelancer'] } }),
      Order.aggregate([
        { $match: { status: 'paid' } },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            paidOrders: { $sum: 1 },
            taxAmount: { $sum: { $ifNull: ['$taxAmount', 0] } },
            commissionAmount: {
              $sum: {
                $ifNull: [
                  '$commissionAmount',
                  {
                    $cond: [
                      { $eq: ['$ownershipType', 'PLATFORM_DIRECT'] },
                      0,
                      { $ifNull: ['$platformFee', 0] },
                    ],
                  },
                ],
              },
            },
            platformRevenueAmount: {
              $sum: {
                $ifNull: [
                  '$platformRevenueAmount',
                  { $ifNull: ['$platformFee', 0] },
                ],
              },
            },
            sellerNet: {
              $sum: {
                $ifNull: ['$sellerNetAmount', { $ifNull: ['$sellerNet', 0] }],
              },
            },
            refundAmount: { $sum: { $ifNull: ['$refundAmount', 0] } },
            chargebackAmount: { $sum: { $ifNull: ['$chargebackAmount', 0] } },
            storeFeeAmount: { $sum: { $ifNull: ['$storeFeeAmount', 0] } },
            playStoreFeeAmount: {
              $sum: {
                $cond: [
                  { $eq: ['$salesChannel', 'GOOGLE_PLAY'] },
                  { $ifNull: ['$storeFeeAmount', 0] },
                  0,
                ],
              },
            },
            appStoreFeeAmount: {
              $sum: {
                $cond: [
                  { $eq: ['$salesChannel', 'APP_STORE'] },
                  { $ifNull: ['$storeFeeAmount', 0] },
                  0,
                ],
              },
            },
          },
        },
      ]),
      Order.aggregate([
        { $match: { status: 'paid' } },
        {
          $group: {
            _id: '$seller',
            grossRevenue: { $sum: '$amount' },
            orders: { $sum: 1 },
            platformFee: {
              $sum: {
                $ifNull: ['$platformRevenueAmount', { $ifNull: ['$platformFee', 0] }],
              },
            },
            sellerNet: {
              $sum: {
                $ifNull: ['$sellerNetAmount', { $ifNull: ['$sellerNet', 0] }],
              },
            },
            taxAmount: { $sum: { $ifNull: ['$taxAmount', 0] } },
            storeFeeAmount: { $sum: { $ifNull: ['$storeFeeAmount', 0] } },
            playStoreFeeAmount: {
              $sum: {
                $cond: [
                  { $eq: ['$salesChannel', 'GOOGLE_PLAY'] },
                  { $ifNull: ['$storeFeeAmount', 0] },
                  0,
                ],
              },
            },
            appStoreFeeAmount: {
              $sum: {
                $cond: [
                  { $eq: ['$salesChannel', 'APP_STORE'] },
                  { $ifNull: ['$storeFeeAmount', 0] },
                  0,
                ],
              },
            },
            commissionAmount: {
              $sum: {
                $ifNull: [
                  '$commissionAmount',
                  {
                    $cond: [
                      { $eq: ['$ownershipType', 'PLATFORM_DIRECT'] },
                      0,
                      { $ifNull: ['$platformFee', 0] },
                    ],
                  },
                ],
              },
            },
          },
        },
        { $sort: { grossRevenue: -1 } },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'sellerDoc',
          },
        },
        {
          $project: {
            _id: 0,
            sellerId: { $toString: '$_id' },
            shopName: {
              $ifNull: [{ $arrayElemAt: ['$sellerDoc.name', 0] }, 'Unknown shop'],
            },
            creatorSlug: {
              $ifNull: [{ $arrayElemAt: ['$sellerDoc.creatorSlug', 0] }, ''],
            },
            avatarUrl: {
              $ifNull: [{ $arrayElemAt: ['$sellerDoc.avatarUrl', 0] }, ''],
            },
            grossRevenue: 1,
            orders: 1,
            platformFee: 1,
            sellerNet: 1,
            taxAmount: 1,
            storeFeeAmount: 1,
            playStoreFeeAmount: 1,
            appStoreFeeAmount: 1,
            commissionAmount: 1,
          },
        },
      ]),
      WalletTx.aggregate([
        { $match: { type: 'deposit', status: { $nin: ['pending', 'failed', 'cancelled'] } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      User.find().select('name email role creatorSlug avatarUrl createdAt accountStatus suspendedUntil').sort({ createdAt: -1 }).limit(20).lean(),
      Product.find().select('name category creatorSlug creatorName featured moderationStatus suspendedUntil published salesCount').sort({ publishedAt: -1 }).limit(20).lean(),
      adminDailySeries({ days: 30 }),
    ]);

    const totalGrossRevenue = revenueAgg[0]?.total || 0;
    const paidOrders = revenueAgg[0]?.paidOrders || 0;
    const platformFee = revenueAgg[0]?.platformRevenueAmount || 0;
    const sellerNet = revenueAgg[0]?.sellerNet || 0;
    const commissionAmount = revenueAgg[0]?.commissionAmount || 0;
    const taxAmount = revenueAgg[0]?.taxAmount || 0;
    const refundAmount = revenueAgg[0]?.refundAmount || 0;
    const chargebackAmount = revenueAgg[0]?.chargebackAmount || 0;
    const storeFeeAmount = revenueAgg[0]?.storeFeeAmount || 0;
    const playStoreFeeAmount = revenueAgg[0]?.playStoreFeeAmount || 0;
    const appStoreFeeAmount = revenueAgg[0]?.appStoreFeeAmount || 0;
    const buyerDeposits = depositAgg[0]?.total || 0;
    const buyerDepositCount = depositAgg[0]?.count || 0;

    const shops = shopAgg.map((row) => ({
      sellerId: row.sellerId,
      shopName: row.shopName,
      creatorSlug: row.creatorSlug || '',
      avatarUrl: row.avatarUrl || '',
      orders: row.orders,
      grossRevenue: row.grossRevenue,
      platformFee: row.platformFee,
      sellerNet: row.sellerNet,
      taxAmount: row.taxAmount || 0,
      storeFeeAmount: row.storeFeeAmount || 0,
      playStoreFeeAmount: row.playStoreFeeAmount || 0,
      appStoreFeeAmount: row.appStoreFeeAmount || 0,
      commissionAmount: row.commissionAmount || 0,
    }));

    res.json({
      users,
      products,
      creators,
      orders,
      reviews,
      paidOrders,
      currency: 'USD',
      platformFeeRate: PLATFORM_COMMISSION_RATE,
      commissionRate: PLATFORM_COMMISSION_RATE,
      totalGrossRevenue,
      gmv: totalGrossRevenue,
      platformFee,
      platformRevenue: platformFee,
      platformCommission: commissionAmount,
      taxWithheld: taxAmount,
      storeFees: storeFeeAmount,
      playStoreFees: playStoreFeeAmount,
      appStoreFees: appStoreFeeAmount,
      refundAmount,
      chargebackAmount,
      sellerNet,
      buyerDeposits,
      buyerDepositCount,
      shops,
      series,
      usersList: usersList.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        role: u.role,
        creatorSlug: u.creatorSlug || '',
        avatarUrl: u.avatarUrl || '',
        accountStatus: u.accountStatus || 'active',
        suspendedUntil: u.suspendedUntil || null,
      })),
      productsList: productsList.map((p) => ({
        id: String(p._id),
        name: p.name,
        category: p.category,
        creatorSlug: p.creatorSlug,
        creatorName: p.creatorName,
        featured: !!p.featured,
        moderationStatus: p.moderationStatus || 'active',
        published: p.published !== false,
        suspendedUntil: p.suspendedUntil || null,
        salesCount: Number(p.salesCount) || 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

function adminUserDto(u, extra = {}) {
  return {
    id: String(u._id),
    email: u.email,
    name: u.name,
    role: u.role,
    creatorSlug: u.creatorSlug || '',
    avatarUrl: u.avatarUrl || '',
    coverUrl: u.coverUrl || '',
    bio: u.bio || '',
    verified: !!u.verified,
    accountStatus: effectiveStatus(u, 'accountStatus'),
    storedStatus: u.accountStatus || 'active',
    suspendedUntil: u.suspendedUntil || null,
    statusReason: u.statusReason || '',
    statusChangedAt: u.statusChangedAt || null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    ...extra,
  };
}

/** GET /v1/admin/revenue-series?granularity=day|week|month — revenue split by period. */
router.get('/revenue-series', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    res.json(await adminSeries({ granularity: String(req.query.granularity || 'day') }));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ message: 'User not found' });
    const [productCount, orderCount, wallet] = await Promise.all([
      Product.countDocuments({ creator: u._id }),
      Order.countDocuments({ $or: [{ buyer: u._id }, { seller: u._id }] }),
      WalletTx.aggregate([
        { $match: { user: u._id, status: { $nin: ['pending', 'failed', 'cancelled'] } } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
    ]);
    res.json(
      adminUserDto(u, {
        productCount,
        orderCount,
        walletByType: Object.fromEntries((wallet || []).map((w) => [w._id, w.total])),
      })
    );
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id/status', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ message: 'User not found' });
    if (String(u._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot change your own account status' });
    }
    const status = String(req.body?.status || '');
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${STATUSES.join(', ')}` });
    }
    applyStatus(u, { status, days: req.body?.days, reason: req.body?.reason }, 'accountStatus');
    await u.save();
    await invalidateAuthUserCache(u._id);
    res.json(adminUserDto(u));
  } catch (err) {
    next(err);
  }
});

router.delete('/users/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ message: 'User not found' });
    if (String(u._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }
    if (u.role === 'admin') {
      const admins = await User.countDocuments({ role: 'admin' });
      if (admins <= 1) return res.status(400).json({ message: 'Cannot delete the last admin' });
    }
    await Product.updateMany({ creator: u._id }, { $set: { moderationStatus: 'inactive', published: false } });
    await User.deleteOne({ _id: u._id });
    await invalidateAuthUserCache(u._id);
    deleteCachePattern('products:*').catch(() => {});
    deleteCachePattern('creators:*').catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function adminProductDto(p) {
  return {
    ...mapProduct(p),
    moderationStatus: effectiveStatus(p, 'moderationStatus'),
    storedStatus: p.moderationStatus || 'active',
    published: p.published !== false,
    suspendedUntil: p.suspendedUntil || null,
    statusReason: p.statusReason || '',
    statusChangedAt: p.statusChangedAt || null,
  };
}

router.get('/products/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ message: 'Product not found' });
    const orders = await Order.countDocuments({ product: p._id });
    res.json({ ...adminProductDto(p), orderCount: orders });
  } catch (err) {
    next(err);
  }
});

router.patch('/products/:id/status', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ message: 'Product not found' });
    const status = String(req.body?.status || '');
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${STATUSES.join(', ')}` });
    }
    applyStatus(p, { status, days: req.body?.days, reason: req.body?.reason }, 'moderationStatus');
    await p.save();
    deleteCachePattern('products:*').catch(() => {});
    res.json(adminProductDto(p));
  } catch (err) {
    next(err);
  }
});

router.delete('/products/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ message: 'Product not found' });
    await Product.deleteOne({ _id: p._id });
    deleteCachePattern('products:*').catch(() => {});
    deleteCachePattern('creators:*').catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/disputes', authenticate, requireRoles('admin'), async (_req, res, next) => {
  try {
    const orders = await Order.find({ disputeStatus: { $ne: 'none' } })
      .sort({ disputeOpenedAt: -1, createdAt: -1 })
      .lean();
    res.json(orders.map((o) => mapOrder(o, { viewerRole: 'admin' })));
  } catch (err) {
    next(err);
  }
});

router.patch('/disputes/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const resolution = String(req.body?.resolution || '');
    const note = String(req.body?.note || '').slice(0, 1000);
    try {
      await resolveOrderDispute(order, { resolution, note, actorId: req.user._id });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ message: err.message });
      }
      throw err;
    }
    res.json(mapOrder(order, { viewerRole: 'admin' }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
