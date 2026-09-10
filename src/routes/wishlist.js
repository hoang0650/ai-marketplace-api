const express = require('express');
const Product = require('../models/Product');
const User = require('../models/User');
const { authenticate, invalidateAuthUserCache } = require('../middleware/auth');
const { mapProduct } = require('../utils/mappers');

const router = express.Router();

async function loadUserDoc(req) {
  const user = await User.findById(req.user._id);
  if (!user) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  return user;
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const user = await loadUserDoc(req);
    await user.populate({ path: 'wishlist' });
    const items = (user.wishlist || []).filter(Boolean).map(mapProduct);
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

    const user = await loadUserDoc(req);
    const list = (user.wishlist || []).map(String);
    const idx = list.indexOf(String(productId));
    let added = false;
    if (idx >= 0) {
      user.wishlist.splice(idx, 1);
    } else {
      user.wishlist.push(product._id);
      added = true;
    }
    await user.save();
    await invalidateAuthUserCache(user._id);
    await user.populate({ path: 'wishlist' });
    res.json({
      wishlist: (user.wishlist || []).filter(Boolean).map(mapProduct),
      added,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
