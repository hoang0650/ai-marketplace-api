const mongoose = require('mongoose');
const Product = require('../models/Product');

function isMongoId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

async function findProductByRef(ref) {
  const id = String(ref || '').trim();
  if (!id) return null;
  if (isMongoId(id)) {
    const byId = await Product.findById(id);
    if (byId) return byId;
  }
  return Product.findOne({ slug: id });
}

function wishlistIdsOf(user) {
  return (user?.wishlist || []).map((item) => String(item?._id || item)).filter(Boolean);
}

function hasWishlistId(user, productId) {
  const id = String(productId);
  return wishlistIdsOf(user).includes(id);
}

module.exports = { isMongoId, findProductByRef, wishlistIdsOf, hasWishlistId };
