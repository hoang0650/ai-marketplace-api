const express = require('express');
const Order = require('../models/Order');
const { authenticate } = require('../middleware/auth');
const { mapOrder } = require('../utils/mappers');
const { openOrderDispute } = require('../utils/open-order-dispute');

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
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    try {
      await openOrderDispute(order, {
        reason,
        actorName: req.user.name,
        href: '/sell/complaints',
      });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ message: err.message, code: err.code });
      }
      throw err;
    }

    res.json(mapOrder(order, { viewerId: req.user._id, viewerRole: req.user.role }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
