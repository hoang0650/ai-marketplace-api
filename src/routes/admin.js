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
const { buildAdminUserDetail } = require('../utils/admin-user-detail');
const { postDisputeMessage, mapDisputeDetail } = require('../utils/dispute-thread');
const {
  wantsPagedDisputes,
  disputeListFilter,
  assertCanResolveDispute,
} = require('../utils/dispute-access');
const { adminDailySeries, adminSeries } = require('../utils/admin-series');
const {
  USER_ROLES,
  USER_STATUSES,
  PRODUCT_STATUSES,
  adminListParams,
  pageResult,
  userStatusFilter,
  productStatusFilter,
} = require('../utils/admin-list');

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
    adminPermissions: Array.isArray(u.adminPermissions) ? u.adminPermissions : [],
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

/**
 * GET /v1/admin/users?page=1&limit=20&q=&role=&status=
 * Every account, newest first. q matches name, email or username (creatorSlug), case-insensitive.
 */
router.get('/users', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const { page, limit, rx } = adminListParams(req.query);
    const and = [];
    if (rx) and.push({ $or: [{ name: rx }, { email: rx }, { creatorSlug: rx }] });
    const role = String(req.query.role || '');
    if (USER_ROLES.includes(role)) and.push({ role });
    const status = String(req.query.status || '');
    if (USER_STATUSES.includes(status)) and.push(userStatusFilter(status));
    const filter = and.length ? { $and: and } : {};
    const [rows, total] = await Promise.all([
      User.find(filter)
        .select('name email role creatorSlug avatarUrl accountStatus suspendedUntil createdAt')
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);
    const items = rows.map((u) => ({
      id: String(u._id),
      name: u.name,
      email: u.email,
      role: u.role,
      creatorSlug: u.creatorSlug || '',
      avatarUrl: u.avatarUrl || '',
      accountStatus: effectiveStatus(u, 'accountStatus'),
      createdAt: u.createdAt || null,
    }));
    res.json(pageResult(items, total, page, limit));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/admin/products?page=1&limit=20&q=&category=&type=&status=&seller=&facets=1
 * Every product (published or not), newest first. q matches title or slug.
 * status: published | unpublished | suspended | blocked | inactive | pending_review.
 * seller: creator user id. facets=1 adds the category / type / seller option lists.
 */
router.get('/products', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const { page, limit, rx } = adminListParams(req.query);
    const and = [];
    if (rx) and.push({ $or: [{ name: rx }, { slug: rx }] });
    const category = String(req.query.category || '').slice(0, 60);
    if (category) and.push({ category });
    const type = String(req.query.type || '').slice(0, 60);
    if (type) and.push({ productType: type });
    const status = String(req.query.status || '');
    if (PRODUCT_STATUSES.includes(status)) and.push(productStatusFilter(status));
    const seller = String(req.query.seller || '');
    if (seller) {
      if (!/^[a-f0-9]{24}$/i.test(seller)) return res.status(400).json({ message: 'seller must be a user id' });
      and.push({ creator: seller });
    }
    const filter = and.length ? { $and: and } : {};
    const wantFacets = String(req.query.facets || '') === '1';
    const [rows, total, facets] = await Promise.all([
      Product.find(filter)
        .select('name slug category productType creator creatorSlug creatorName published moderationStatus suspendedUntil salesCount createdAt')
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
      wantFacets
        ? Product.aggregate([
            {
              $facet: {
                categories: [{ $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
                types: [{ $group: { _id: '$productType', n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
                sellers: [
                  { $group: { _id: '$creator', name: { $first: '$creatorName' }, slug: { $first: '$creatorSlug' }, n: { $sum: 1 } } },
                  { $sort: { name: 1 } },
                ],
              },
            },
          ])
        : null,
    ]);
    const items = rows.map((p) => ({
      id: String(p._id),
      name: p.name,
      slug: p.slug,
      category: p.category,
      productType: p.productType || '',
      creatorId: p.creator ? String(p.creator) : '',
      creatorSlug: p.creatorSlug || '',
      creatorName: p.creatorName || '',
      published: p.published !== false,
      moderationStatus: effectiveStatus(p, 'moderationStatus'),
      salesCount: Number(p.salesCount) || 0,
      createdAt: p.createdAt || null,
    }));
    const out = pageResult(items, total, page, limit);
    if (facets) {
      const f = facets[0] || {};
      out.facets = {
        categories: (f.categories || []).filter((c) => c._id).map((c) => ({ id: c._id, count: c.n })),
        types: (f.types || []).filter((c) => c._id).map((c) => ({ id: c._id, count: c.n })),
        sellers: (f.sellers || [])
          .filter((c) => c._id)
          .map((c) => ({ id: String(c._id), name: c.name || c.slug || '', slug: c.slug || '', count: c.n })),
      };
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

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
    res.json(await buildAdminUserDetail(u, adminUserDto(u)));
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
    res.json(await buildAdminUserDetail(u, adminUserDto(u)));
  } catch (err) {
    next(err);
  }
});

/**
 * Least-privilege staff permissions (admin only). Example: grant 'finance.tax' to a kế toán thuế
 * account so it can export tax reports and review Mẫu 08/CK-TNCN without full admin rights.
 */
router.patch('/users/:id/permissions', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const { normalizeAdminPermissions, ADMIN_PERMISSIONS } = require('../utils/roles');
    if (!Array.isArray(req.body?.adminPermissions)) {
      return res.status(400).json({ message: `adminPermissions must be an array of: ${ADMIN_PERMISSIONS.join(', ')}` });
    }
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ message: 'User not found' });
    const before = [...(u.adminPermissions || [])];
    u.adminPermissions = normalizeAdminPermissions(req.body.adminPermissions);
    await u.save();
    await invalidateAuthUserCache(u._id);
    try {
      const { writeAuditLog } = require('../utils/audit');
      await writeAuditLog({ actorId: req.user._id, actorRole: 'admin', action: 'admin.user.permissions', resourceType: 'User', resourceId: String(u._id), oldValue: { adminPermissions: before }, newValue: { adminPermissions: u.adminPermissions } });
    } catch {
      /* audit is best-effort */
    }
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

function disputeError(res, err) {
  if (!err.status) return false;
  res.status(err.status).json({ message: err.message, code: err.code });
  return true;
}

router.get('/disputes', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const sort = { disputeOpenedAt: -1, createdAt: -1 };
    // No list params: the current admin tab expects a bare array.
    if (!wantsPagedDisputes(req.query)) {
      const orders = await Order.find({ disputeStatus: { $ne: 'none' } }).sort(sort).lean();
      return res.json(orders.map((o) => mapOrder(o, { viewerRole: 'admin' })));
    }
    const status = String(req.query.status || '');
    if (status && status !== 'open' && status !== 'resolved') {
      return res.status(400).json({ message: 'status must be open or resolved', code: 'DISPUTE_STATUS' });
    }
    const { page, limit, q, rx } = adminListParams(req.query);
    const filter = disputeListFilter({ status, q, rx });
    const [rows, total, openCount] = await Promise.all([
      Order.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      Order.countDocuments(filter),
      Order.countDocuments({ disputeStatus: 'open' }),
    ]);
    res.json({
      ...pageResult(rows.map((o) => mapOrder(o, { viewerRole: 'admin' })), total, page, limit),
      openCount,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/disputes/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order || (order.disputeStatus || 'none') === 'none') {
      return res.status(404).json({ message: 'Dispute not found', code: 'DISPUTE_NOT_FOUND' });
    }
    res.json(await mapDisputeDetail(order, { viewerRole: 'admin' }));
  } catch (err) {
    next(err);
  }
});

router.post('/disputes/:id/messages', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Dispute not found', code: 'DISPUTE_NOT_FOUND' });
    try {
      await postDisputeMessage(order, req.user, { body: req.body?.body, attachmentIds: req.body?.attachmentIds });
    } catch (err) {
      if (disputeError(res, err)) return;
      throw err;
    }
    res.status(201).json(await mapDisputeDetail(order, { viewerRole: 'admin' }));
  } catch (err) {
    next(err);
  }
});

router.post('/disputes/:id/decision', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    try {
      assertCanResolveDispute(req.user, order);
      const updated = await resolveOrderDispute(order, {
        resolution: req.body?.resolution,
        note: req.body?.note || req.body?.reason || '',
        refundAmount: req.body?.refundAmount,
        actorId: req.user._id,
        requireNote: true,
      });
      res.json(await mapDisputeDetail(updated, { viewerRole: 'admin' }));
    } catch (err) {
      if (disputeError(res, err)) return;
      throw err;
    }
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
    const partial = req.body?.refundAmount != null && req.body.refundAmount !== '';
    try {
      const updated = await resolveOrderDispute(order, {
        resolution,
        note,
        refundAmount: req.body?.refundAmount,
        actorId: req.user._id,
        requireNote: resolution === 'split' || partial,
      });
      res.json(mapOrder(updated, { viewerRole: 'admin' }));
    } catch (err) {
      if (disputeError(res, err)) return;
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
