const express = require('express');
const Product = require('../models/Product');
const Order = require('../models/Order');
const WalletTx = require('../models/WalletTx');
const Notification = require('../models/Notification');
const { authenticate } = require('../middleware/auth');
const { splitRevenue } = require('../utils/platform');
const { deleteCachePattern } = require('../utils/cache');
const { clampQty } = require('../utils/sales');
const { getBalance } = require('../utils/wallet');
const { HOLD_MS } = require('../utils/payout-hold');

const router = express.Router();

router.post('/checkout', authenticate, async (req, res, next) => {
  try {
    const productId = req.body?.productId;
    const quantity = clampQty(req.body?.quantity);
    if (!productId) return res.status(400).json({ message: 'productId required' });

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const unit =
      product.pricing?.model === 'usage'
        ? Number(product.pricing.usageRate) || 0
        : Number(product.pricing.price) || 0;
    const amount = Math.round(unit * quantity * 100) / 100;
    const currency = product.pricing?.currency || 'USD';

    if (amount > 0) {
      const balance = await getBalance(req.user._id);
      if (balance < amount) {
        return res.status(402).json({
          message: `Insufficient aimarkets.vn wallet balance (need ${amount.toFixed(2)} ${currency}, have ${balance.toFixed(2)}). Please top up.`,
          code: 'INSUFFICIENT_WALLET',
          amount,
          balance,
          currency,
        });
      }
    }

    const now = new Date();
    const split = amount > 0 ? splitRevenue(amount) : { sellerNet: 0, platformFee: 0 };

    const order = await Order.create({
      product: product._id,
      productName: product.name,
      buyer: req.user._id,
      buyerName: req.user.name,
      seller: product.creator,
      quantity,
      amount,
      currency,
      sellerNet: split.sellerNet,
      platformFee: split.platformFee,
      completedAt: now,
      payoutHoldUntil: new Date(now.getTime() + HOLD_MS),
      disputeStatus: 'none',
      status: 'paid',
      provider: 'wallet',
    });

    if (amount > 0) {
      await WalletTx.create({
        user: req.user._id,
        type: 'debit',
        amount,
        currency,
        note: `Pay ${product.name} ×${quantity} (aimarkets.vn wallet)`,
      });
      if (split.sellerNet > 0) {
        await WalletTx.create({
          user: product.creator,
          type: 'credit',
          amount: split.sellerNet,
          currency,
          note: `Sale: ${product.name} (held 48h / until dispute closes)`,
        });
      }
    }

    await Product.updateOne({ _id: product._id }, { $inc: { salesCount: quantity } });
    deleteCachePattern('products:*').catch(() => {});
    deleteCachePattern('creators:*').catch(() => {});

    await Notification.create({
      user: product.creator,
      title: 'New order',
      body: `${req.user.name} purchased ${product.name} via aimarkets.vn wallet`,
      href: '/dashboard/orders',
    });

    const balance = await getBalance(req.user._id);
    res.status(201).json({
      checkoutId: `chk_${order._id.toString()}`,
      provider: 'wallet',
      status: 'paid',
      quantity,
      amount,
      currency,
      balance,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
