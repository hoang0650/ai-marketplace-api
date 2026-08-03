const express = require('express');
const Product = require('../models/Product');
const { authenticate, requireRoles } = require('../middleware/auth');
const { mapProduct } = require('../utils/mappers');
const { slugify } = require('../utils/serialize');

const router = express.Router();

/** Escape user input before embedding in a RegExp (prevents ReDoS / regex injection). */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.category) filter.category = String(req.query.category);
    if (req.query.creatorSlug) filter.creatorSlug = String(req.query.creatorSlug);
    if (req.query.featured === 'true') filter.featured = true;

    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) {
      const safe = new RegExp(escapeRegExp(q), 'i');
      filter.$or = [
        { name: safe },
        { tagline: safe },
        { description: safe },
        { tags: safe },
      ];
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const products = await Product.find(filter)
      .sort({ featured: -1, publishedAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean();
    res.json(products.map(mapProduct));
  } catch (err) {
    next(err);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const product = await Product.findOne({ slug: String(req.params.slug).toLowerCase() }).lean();
    if (!product) return res.status(404).json({ message: 'Not found' });
    res.json(mapProduct(product));
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name || !body.category || !body.pricing) {
      return res.status(400).json({ message: 'name, category, pricing are required' });
    }
    let slug = slugify(body.slug || name);
    if (!slug) slug = `product-${Date.now()}`;
    const exists = await Product.findOne({ slug });
    if (exists) slug = `${slug}-${Date.now().toString(36)}`;

    const user = req.user;
    if (user.role === 'creator' && !user.creatorSlug) {
      return res.status(400).json({ message: 'Creator profile missing slug' });
    }

    const product = await Product.create({
      slug,
      name,
      tagline: body.tagline || '',
      description: body.description || '',
      category: body.category,
      creator: user._id,
      creatorSlug: user.creatorSlug || 'admin',
      creatorName: user.name,
      coverUrl: body.coverUrl || '',
      gallery: Array.isArray(body.gallery) ? body.gallery : [],
      pricing: body.pricing,
      tags: Array.isArray(body.tags) ? body.tags : [],
      apiDocsMarkdown: body.apiDocsMarkdown || '',
      changelog: Array.isArray(body.changelog) ? body.changelog : [],
      featured: !!body.featured,
      publishedAt: body.publishedAt ? new Date(body.publishedAt) : new Date(),
    });

    res.status(201).json(mapProduct(product));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Not found' });
    if (
      req.user.role !== 'admin' &&
      String(product.creator) !== String(req.user._id)
    ) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const body = req.body || {};
    const fields = [
      'name',
      'tagline',
      'description',
      'category',
      'coverUrl',
      'gallery',
      'pricing',
      'tags',
      'apiDocsMarkdown',
      'changelog',
      'featured',
    ];
    for (const key of fields) {
      if (body[key] !== undefined) product[key] = body[key];
    }
    if (body.slug) product.slug = slugify(body.slug) || product.slug;
    await product.save();
    res.json(mapProduct(product));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Not found' });
    if (
      req.user.role !== 'admin' &&
      String(product.creator) !== String(req.user._id)
    ) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    await product.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
