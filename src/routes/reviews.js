const express = require('express');
const Review = require('../models/Review');
const Product = require('../models/Product');
const { authenticate } = require('../middleware/auth');
const { mapReview } = require('../utils/mappers');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.productId) filter.product = req.query.productId;
    const reviews = await Review.find(filter).sort({ createdAt: -1 }).lean();
    res.json(reviews.map(mapReview));
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, async (req, res, next) => {
  try {
    const productId = req.body?.productId;
    const rating = Number(req.body?.rating);
    if (!productId || !Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'productId and rating (1-5) required' });
    }
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const review = await Review.create({
      product: product._id,
      user: req.user._id,
      userName: req.user.name,
      rating,
      title: String(req.body?.title || '').trim(),
      body: String(req.body?.body || '').trim(),
    });

    const agg = await Review.aggregate([
      { $match: { product: product._id } },
      { $group: { _id: '$product', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    if (agg[0]) {
      product.rating = Math.round(agg[0].avg * 10) / 10;
      product.reviewCount = agg[0].count;
      await product.save();
    }

    res.status(201).json(mapReview(review));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
