const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Review = require('../models/Review');
const WalletTx = require('../models/WalletTx');
const { authenticate, requireRoles } = require('../middleware/auth');
const { PLATFORM_FEE_RATE, splitRevenue } = require('../utils/platform');

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
      User.find().select('name email role creatorSlug avatarUrl createdAt').sort({ createdAt: -1 }).limit(20).lean(),
      Product.find().select('name category creatorSlug creatorName featured').sort({ publishedAt: -1 }).limit(20).lean(),
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
      })),
      productsList: productsList.map((p) => ({
        id: String(p._id),
        name: p.name,
        category: p.category,
        creatorSlug: p.creatorSlug,
        creatorName: p.creatorName,
        featured: !!p.featured,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
