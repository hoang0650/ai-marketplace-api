const express = require('express');
const Order = require('../models/Order');
const Notification = require('../models/Notification');
const { authenticate } = require('../middleware/auth');
const { mapOrder } = require('../utils/mappers');
const { canOpenDispute } = require('../utils/payout-hold');

const router = express.Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const filter =
      req.user.role === 'admin'
        ? {}
        : req.user.role === 'creator'
          ? { $or: [{ seller: req.user._id }, { buyer: req.user._id }] }
          : { buyer: req.user._id };
    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean();
    res.json(orders.map((o) => mapOrder(o, { viewerId: req.user._id, viewerRole: req.user.role })));
  } catch (err) {
    next(err);
  }
});

router.get('/disputes', authenticate, async (req, res, next) => {
  try {
    const filter =
      req.user.role === 'admin'
        ? { disputeStatus: { $ne: 'none' } }
        : {
            disputeStatus: { $ne: 'none' },
            $or: [{ buyer: req.user._id }, { seller: req.user._id }],
          };
    const orders = await Order.find(filter).sort({ disputeOpenedAt: -1, createdAt: -1 }).lean();
    res.json(orders.map((o) => mapOrder(o, { viewerId: req.user._id, viewerRole: req.user.role })));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/dispute', authenticate, async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (String(order.buyer) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only the buyer can open a dispute on this order' });
    }
    if (!canOpenDispute(order)) {
      return res.status(400).json({
        message:
          'Cannot dispute this order. Disputes are only allowed within 48 hours of completion, and only once.',
        code: 'DISPUTE_WINDOW_CLOSED',
      });
    }
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    if (reason.length < 8) {
      return res.status(400).json({ message: 'Please describe the issue (at least 8 characters)' });
    }
    order.disputeStatus = 'open';
    order.disputeReason = reason;
    order.disputeOpenedAt = new Date();
    await order.save();

    await Notification.create({
      user: order.seller,
      title: 'Khiếu nại đơn hàng',
      body: `${req.user.name} disputed ${order.productName}. Seller net $${Number(order.sellerNet || 0).toFixed(2)} is frozen until resolved.`,
      href: '/dashboard/orders',
    });

    res.json(mapOrder(order, { viewerId: req.user._id, viewerRole: req.user.role }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
