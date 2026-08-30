const express = require('express');
const Product = require('../models/Product');
const MarketplaceApiKey = require('../models/MarketplaceApiKey');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function publicKey(doc) {
  return {
    id: String(doc._id),
    prefix: doc.prefix,
    name: doc.name,
    productSlug: doc.productSlug,
    status: doc.status,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
  };
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const rows = await MarketplaceApiKey.find({ user: req.user._id, status: 'active' }).sort({ createdAt: -1 });
    res.json(rows.map(publicKey));
  } catch (e) {
    next(e);
  }
});

router.post('/', authenticate, async (req, res, next) => {
  try {
    const slug = String(req.body?.productSlug || '').toLowerCase();
    const product = await Product.findOne({ slug });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const minted = MarketplaceApiKey.mintKey();
    const doc = await MarketplaceApiKey.create({
      user: req.user._id,
      product: product._id,
      productSlug: product.slug,
      name: String(req.body?.name || 'default').slice(0, 80),
      prefix: minted.prefix,
      keyHash: minted.keyHash,
    });
    res.status(201).json({
      ...publicKey(doc),
      apiKey: minted.plaintext,
      hint: 'Store this key now. The server only keeps a hash.',
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const doc = await MarketplaceApiKey.findOne({ _id: req.params.id, user: req.user._id });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    doc.status = 'revoked';
    doc.revokedAt = new Date();
    await doc.save();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
