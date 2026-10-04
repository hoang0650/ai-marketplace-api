const express = require('express');
const Cart = require('../models/Cart');
const { authenticate } = require('../middleware/auth');
const { mapProduct } = require('../utils/mappers');
const { findProductByRef, isMongoId } = require('../utils/wishlist');
const { applyCartLine, removeCartLines } = require('../utils/cart');

const router = express.Router();

async function loadCart(userId) {
  return (await Cart.findOne({ user: userId })) || new Cart({ user: userId, items: [] });
}

async function respond(res, cart) {
  await cart.populate({ path: 'items.product' });
  const items = (cart.items || [])
    .filter((it) => it.product)
    .map((it) => ({ product: mapProduct(it.product), qty: it.qty, addedAt: it.addedAt }))
    .filter((it) => it.product);
  res.json({ items, count: items.reduce((s, it) => s + it.qty, 0) });
}

async function resolveProductId(ref) {
  const product = await findProductByRef(ref);
  if (product) return String(product._id);
  return isMongoId(ref) ? ref : null;
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    await respond(res, await loadCart(req.user._id));
  } catch (err) {
    next(err);
  }
});

router.post('/items', authenticate, async (req, res, next) => {
  try {
    const ref = String(req.body?.productId || req.body?.slug || '').trim();
    if (!ref) return res.status(400).json({ message: 'productId required' });
    const product = await findProductByRef(ref);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const cart = await loadCart(req.user._id);
    cart.items = applyCartLine(cart.items, product._id, req.body?.qty ?? 1, 'add');
    await cart.save();
    await respond(res, cart);
  } catch (err) {
    next(err);
  }
});

router.patch('/items/:ref', authenticate, async (req, res, next) => {
  try {
    const qty = Number(req.body?.qty);
    if (!Number.isFinite(qty)) return res.status(400).json({ message: 'qty required' });
    const id = await resolveProductId(String(req.params.ref || '').trim());
    if (!id) return res.status(404).json({ message: 'Product not found' });
    const cart = await loadCart(req.user._id);
    cart.items = applyCartLine(cart.items, id, qty, 'set');
    await cart.save();
    await respond(res, cart);
  } catch (err) {
    next(err);
  }
});

router.delete('/items/:ref', authenticate, async (req, res, next) => {
  try {
    const id = await resolveProductId(String(req.params.ref || '').trim());
    const cart = await loadCart(req.user._id);
    if (id) {
      cart.items = removeCartLines(cart.items, [id]);
      await cart.save();
    }
    await respond(res, cart);
  } catch (err) {
    next(err);
  }
});

router.post('/remove', authenticate, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.productIds) ? req.body.productIds.map(String) : [];
    const cart = await loadCart(req.user._id);
    if (ids.length) {
      cart.items = removeCartLines(cart.items, ids);
      await cart.save();
    }
    await respond(res, cart);
  } catch (err) {
    next(err);
  }
});

router.delete('/', authenticate, async (req, res, next) => {
  try {
    const cart = await loadCart(req.user._id);
    cart.items = [];
    await cart.save();
    await respond(res, cart);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
