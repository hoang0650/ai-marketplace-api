const express = require('express');
const Order = require('../models/Order');
const { authenticate } = require('../middleware/auth');
const { mapOrder } = require('../utils/mappers');

const router = express.Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const filter =
      req.user.role === 'admin'
        ? {}
        : req.user.role === 'creator'
          ? { seller: req.user._id }
          : { buyer: req.user._id };
    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean();
    res.json(orders.map(mapOrder));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
