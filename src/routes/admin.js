const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Review = require('../models/Review');
const WalletTx = require('../models/WalletTx');
const Notification = require('../models/Notification');
const { authenticate, requireRoles } = require('../middleware/auth');
const { PLATFORM_FEE_RATE, splitRevenue } = require('../utils/platform');
const { applyStatus, STATUSES, effectiveStatus } = require('../utils/moderation');
const { deleteCachePattern } = require('../utils/cache');
const { mapProduct, mapOrder } = require('../utils/mappers');
const { effectiveSellerNet } = require('../utils/payout-hold');

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
    ] = await Promise.all([
      User.countDocuments(),
      Product.countDocuments(),
      Order.countDocuments(),
      Review.countDocuments(),
      User.countDocuments({ role: 'creator' }),
      Order.aggregate([
        { $match: { status: 'paid' } },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            paidOrders: { $sum: 1 },
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
          },
        },
      ]),
      WalletTx.aggregate([
        { $match: { type: 'deposit' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      User.find().select('name email role creatorSlug avatarUrl createdAt accountStatus suspendedUntil').sort({ createdAt: -1 }).limit(20).lean(),
      Product.find().select('name category creatorSlug creatorName featured moderationStatus suspendedUntil published salesCount').sort({ publishedAt: -1 }).limit(20).lean(),
    ]);

    const totalGrossRevenue = revenueAgg[0]?.total || 0;
    const paidOrders = revenueAgg[0]?.paidOrders || 0;
    const { platformFee, sellerNet } = splitRevenue(totalGrossRevenue);
    const buyerDeposits = depositAgg[0]?.total || 0;
    const buyerDepositCount = depositAgg[0]?.count || 0;

    const shops = shopAgg.map((row) => {
      const split = splitRevenue(row.grossRevenue);
      return {
        sellerId: row.sellerId,
        shopName: row.shopName,
        creatorSlug: row.creatorSlug || '',
        avatarUrl: row.avatarUrl || '',
        orders: row.orders,
        grossRevenue: split.gross,
        platformFee: split.platformFee,
        sellerNet: split.sellerNet,
      };
    });

    res.json({
      users,
      products,
      creators,
      orders,
      reviews,
      paidOrders,
      currency: 'USD',
      platformFeeRate: PLATFORM_FEE_RATE,
      /** GMV / tổng doanh thu toàn sàn (paid orders) */
      totalGrossRevenue,
      gmv: totalGrossRevenue,
      /** Phí nền tảng 20% */
      platformFee,
      /** Phần seller nhận (80%) */
      sellerNet,
      /** Tổng tiền buyer nạp vào ví */
      buyerDeposits,
      buyerDepositCount,
      shops,
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

router.get('/users/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ message: 'User not found' });
    const [productCount, orderCount, wallet] = await Promise.all([
      Product.countDocuments({ creator: u._id }),
      Order.countDocuments({ $or: [{ buyer: u._id }, { seller: u._id }] }),
      WalletTx.aggregate([{ $match: { user: u._id } }, { $group: { _id: '$type', total: { $sum: '$amount' } } }]),
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
    if (order.disputeStatus !== 'open') {
      return res.status(400).json({ message: 'This order has no open dispute' });
    }
    const resolution = String(req.body?.resolution || '');
    if (!['seller', 'buyer'].includes(resolution)) {
      return res.status(400).json({ message: 'resolution must be seller or buyer' });
    }
    const note = String(req.body?.note || '').slice(0, 1000);
    order.disputeResolvedAt = new Date();
    order.disputeResolutionNote = note;

    if (resolution === 'seller') {
      order.disputeStatus = 'seller_win';
      await order.save();
      await Notification.create({
        user: order.seller,
        title: 'Khiếu nại đã đóng',
        body: `Dispute on ${order.productName} resolved for the seller. Payout is now withdrawable.`,
        href: '/dashboard/withdraw',
      });
      await Notification.create({
        user: order.buyer,
        title: 'Khiếu nại đã đóng',
        body: `Dispute on ${order.productName} was resolved in the seller's favor.`,
        href: '/profile',
      });
    } else {
      order.disputeStatus = 'buyer_win';
      order.status = 'refunded';
      await order.save();
      const gross = Number(order.amount) || 0;
      const net = effectiveSellerNet(order);
      const currency = order.currency || 'USD';
      if (gross > 0) {
        await WalletTx.create({
          user: order.buyer,
          type: 'credit',
          amount: gross,
          currency,
          note: `Refund: ${order.productName} (dispute)`,
        });
      }
      if (net > 0) {
        await WalletTx.create({
          user: order.seller,
          type: 'debit',
          amount: net,
          currency,
          note: `Dispute refund: ${order.productName} (this order only)`,
        });
      }
      await Notification.create({
        user: order.buyer,
        title: 'Hoàn tiền khiếu nại',
        body: `Refunded ${gross.toFixed(2)} ${currency} for ${order.productName}.`,
        href: '/wallet',
      });
      await Notification.create({
        user: order.seller,
        title: 'Khiếu nại: hoàn tiền người mua',
        body: `Seller net ${net.toFixed(2)} ${currency} for ${order.productName} was reversed. Other wallet funds were not frozen.`,
        href: '/dashboard/orders',
      });
    }

    res.json(mapOrder(order, { viewerRole: 'admin' }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
