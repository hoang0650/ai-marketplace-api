const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const UsageStat = require('../models/UsageStat');
const { authenticate, requireRoles } = require('../middleware/auth');

const router = express.Router();

router.get('/summary', authenticate, requireRoles('seller', 'admin'), async (req, res, next) => {
  try {
    const sellerId = req.user._id;
    const paidOrders = await Order.find({ seller: sellerId, status: 'paid' }).lean();
    const orders = paidOrders.length;
    const revenue = paidOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    const platformCommission = paidOrders.reduce(
      (s, o) => s + (Number(o.commissionAmount ?? (o.ownershipType === 'PLATFORM_DIRECT' ? 0 : o.platformFee)) || 0),
      0,
    );
    const taxWithheld = paidOrders.reduce((s, o) => s + (Number(o.taxAmount) || 0), 0);
    const storeFees = paidOrders.reduce((s, o) => s + (Number(o.storeFeeAmount) || 0), 0);
    const netPayable = paidOrders.reduce(
      (s, o) => s + (Number(o.sellerNetAmount ?? o.sellerNet) || 0),
      0,
    );
    const refunds = paidOrders.reduce((s, o) => s + (Number(o.refundAmount) || 0), 0);
    const activeProducts = await Product.countDocuments({ creator: sellerId });
    const usage = await UsageStat.find({ creator: sellerId }).lean();
    const tokenUsage = usage.reduce((s, u) => s + (Number(u.tokens) || 0), 0);
    const gpuHours = usage.reduce((s, u) => s + (Number(u.gpuHours) || 0), 0);

    res.json({
      revenue,
      grossSales: revenue,
      platformCommission,
      storeFees,
      taxWithholding: taxWithheld,
      refunds,
      netPayable,
      orders,
      tokenUsage,
      gpuHours,
      activeProducts,
      currency: 'USD',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
