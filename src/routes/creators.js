const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const { mapCreator } = require('../utils/mappers');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const creators = await User.find({
      role: { $in: ['creator', 'admin'] },
      creatorSlug: { $exists: true, $ne: '' },
    });
    const mapped = await Promise.all(creators.map((u) => mapCreator(u, Product)));
    res.json(mapped);
  } catch (err) {
    next(err);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const user = await User.findOne({ creatorSlug: String(req.params.slug).toLowerCase() });
    if (!user) return res.status(404).json({ message: 'Not found' });
    res.json(await mapCreator(user, Product));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
