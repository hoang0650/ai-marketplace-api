const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const { mapCreator } = require('../utils/mappers');
const { cached } = require('../utils/cache');

const router = express.Router();

const CREATORS_TTL = 300; // s — profile/product counts change rarely

router.get('/', async (_req, res, next) => {
  try {
    const result = await cached('creators:list', CREATORS_TTL, async () => {
      const creators = await User.find({
        role: { $in: ['creator', 'admin'] },
        creatorSlug: { $exists: true, $ne: '' },
      });
      return Promise.all(creators.map((u) => mapCreator(u, Product)));
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug).toLowerCase();
    const result = await cached(`creators:slug:${slug}`, CREATORS_TTL, async () => {
      const user = await User.findOne({ creatorSlug: slug });
      return user ? await mapCreator(user, Product) : null;
    });
    if (!result) return res.status(404).json({ message: 'Not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
