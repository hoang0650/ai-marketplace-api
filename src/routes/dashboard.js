const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const UsageStat = require('../models/UsageStat');
const { authenticate, requireRoles } = require('../middleware/auth');

const router = express.Router();

router.get('/summary', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const sellerId = req.user._id;
    const paidOrders = await Order.find({ seller: sellerId, status: 'paid' }).lean();
    const revenue = paidOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    const orders = paidOrders.length;
    const activeProducts = await Product.countDocuments({ creator: sellerId });
    const usage = await UsageStat.find({ creator: sellerId }).lean();
    const tokenUsage = usage.reduce((s, u) => s + (Number(u.tokens) || 0), 0);
    const gpuHours = usage.reduce((s, u) => s + (Number(u.gpuHours) || 0), 0);

    res.json({
      revenue,
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
