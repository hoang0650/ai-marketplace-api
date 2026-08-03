const express = require('express');
const Product = require('../models/Product');
const { authenticate } = require('../middleware/auth');
const { mapProduct } = require('../utils/mappers');

const router = express.Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    await req.user.populate({ path: 'wishlist' });
    const items = (req.user.wishlist || []).filter(Boolean).map(mapProduct);
    res.json(items);
  } catch (err) {
    next(err);
  }
});

router.post('/toggle', authenticate, async (req, res, next) => {
  try {
    const productId = req.body?.productId;
    if (!productId) return res.status(400).json({ message: 'productId required' });
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const list = req.user.wishlist.map(String);
    const idx = list.indexOf(String(productId));
    let added = false;
    if (idx >= 0) {
      req.user.wishlist.splice(idx, 1);
    } else {
      req.user.wishlist.push(product._id);
      added = true;
    }
    await req.user.save();
    await req.user.populate({ path: 'wishlist' });
    res.json({
      wishlist: (req.user.wishlist || []).filter(Boolean).map(mapProduct),
      added,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
