const express = require('express');
const User = require('../models/User');
const { authenticate, invalidateAuthUserCache } = require('../middleware/auth');
const { mapProduct } = require('../utils/mappers');
const { findProductByRef, hasWishlistId } = require('../utils/wishlist');

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

function mappedWishlist(user) {
  return (user.wishlist || []).filter(Boolean).map(mapProduct).filter(Boolean);
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const user = await loadUserDoc(req);
    await user.populate({ path: 'wishlist' });
    res.json(mappedWishlist(user));
  } catch (err) {
    next(err);
  }
});

router.post('/toggle', authenticate, async (req, res, next) => {
  try {
    const ref = String(req.body?.productId || req.body?.slug || '').trim();
    if (!ref) return res.status(400).json({ message: 'productId required' });
    const product = await findProductByRef(ref);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const user = await loadUserDoc(req);
    const added = !hasWishlistId(user, product._id);
    if (added) {
      await User.updateOne({ _id: user._id }, { $addToSet: { wishlist: product._id } });
    } else {
      await User.updateOne({ _id: user._id }, { $pull: { wishlist: product._id } });
    }
    await invalidateAuthUserCache(user._id);
    const fresh = await User.findById(user._id).populate({ path: 'wishlist' });
    res.json({
      wishlist: mappedWishlist(fresh),
      added,
      productId: String(product._id),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
