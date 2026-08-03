const express = require('express');
const Notification = require('../models/Notification');
const { authenticate } = require('../middleware/auth');
const { mapNotification } = require('../utils/mappers');

const router = express.Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const items = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json(items.map(mapNotification));
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', authenticate, async (req, res, next) => {
  try {
    await Notification.updateMany({ user: req.user._id, read: false }, { $set: { read: true } });
    const items = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json(items.map(mapNotification));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
