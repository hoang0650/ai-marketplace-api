const express = require('express');
const Product = require('../models/Product');
const Order = require('../models/Order');
const WalletTx = require('../models/WalletTx');
const Notification = require('../models/Notification');
const { authenticate } = require('../middleware/auth');
const { splitRevenue } = require('../utils/platform');

const router = express.Router();

router.post('/checkout', authenticate, async (req, res, next) => {
  try {
    const productId = req.body?.productId;
    const provider = req.body?.provider || 'stripe';
    if (!productId) return res.status(400).json({ message: 'productId required' });
    if (!['stripe', 'paypal', 'paddle', 'payos'].includes(provider)) {
      return res.status(400).json({ message: 'Invalid provider' });
    }

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const amount =
      product.pricing?.model === 'usage'
        ? Number(product.pricing.usageRate) || 0
        : Number(product.pricing.price) || 0;

    const order = await Order.create({
      product: product._id,
      productName: product.name,
      buyer: req.user._id,
      buyerName: req.user.name,
      seller: product.creator,
      amount,
      currency: product.pricing?.currency || 'USD',
      status: 'paid',
      provider,
    });

    product.installCount = (product.installCount || 0) + 1;
    await product.save();

    if (amount > 0) {
      const { sellerNet } = splitRevenue(amount);
      await WalletTx.create({
        user: product.creator,
        type: 'credit',
        amount: sellerNet,
        currency: order.currency,
        note: `Sale: ${product.name} (net after 20% platform fee)`,
      });
    }

    await Notification.create({
      user: product.creator,
      title: 'New order',
      body: `${req.user.name} purchased ${product.name}`,
      href: '/dashboard/orders',
    });

    res.status(201).json({
      checkoutId: `chk_${order._id.toString()}`,
      provider,
      status: 'created',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
