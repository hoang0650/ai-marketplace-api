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
    const taxVatWithheld = paidOrders.reduce((s, o) => s + (Number(o.taxPolicy?.vatAmount) || 0), 0);
    const taxPitWithheld = paidOrders.reduce((s, o) => s + (Number(o.taxPolicy?.pitAmount) || 0), 0);
    const SellerProfile = require('../models/SellerProfile');
    const { normalizeSellerType } = require('../finance/seller-types');
    const { sellerTaxRateFor } = require('../finance/seller-tax-policy');
    const sp = await SellerProfile.findOne({ user: sellerId }).select('sellerType sellerTypeDeclaredAt').lean();
    const sellerType = normalizeSellerType(sp?.sellerType);
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
      taxVatWithheld,
      taxPitWithheld,
      /** Tax policy 2026-10: rate follows the declared seller type. */
      sellerType,
      sellerTypeDeclared: !!sp?.sellerTypeDeclaredAt,
      sellerTaxRate: sellerTaxRateFor(sellerType, 'AI_API'),
      sellerTaxRates: {
        DIGITAL: sellerTaxRateFor(sellerType, 'AI_API'),
        PHYSICAL: sellerTaxRateFor(sellerType, 'PHYSICAL_GOODS'),
      },
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
