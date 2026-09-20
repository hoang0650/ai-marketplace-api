const express = require('express');
const Coupon = require('../models/Coupon');
const Product = require('../models/Product');
const { authenticate, requireRoles } = require('../middleware/auth');
const {
  normalizeCode,
  mapCoupon,
  parseProductIds,
  previewCoupon,
} = require('../utils/coupon');
const { isLicenseCategory, resolveLicensePrice } = require('../utils/license-keys');
const { clampQty } = require('../utils/sales');

const router = express.Router();

function unitForProduct(product, licenseTerm) {
  const licensePick = isLicenseCategory(product.category)
    ? resolveLicensePrice(product.toObject ? product.toObject() : product, licenseTerm)
    : null;
  if (licensePick) return Number(licensePick.unitPrice) || 0;
  if (product.pricing?.model === 'usage') return Number(product.pricing.usageRate) || 0;
  return Number(product.pricing?.price) || 0;
}

router.get('/', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const filter = req.user.role === 'admin' && req.query.all === 'true' ? {} : { seller: req.user._id };
    const rows = await Coupon.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json(rows.map(mapCoupon));
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const code = normalizeCode(body.code);
    if (code.length < 3) return res.status(400).json({ message: 'Code must be 3–24 letters or numbers.', code: 'COUPON_CODE' });
    const type = body.type === 'amount' ? 'amount' : 'percent';
    const value = Number(body.value);
    if (!(value > 0)) return res.status(400).json({ message: 'Discount value required.', code: 'COUPON_VALUE' });
    if (type === 'percent' && value > 90) {
      return res.status(400).json({ message: 'Percent discount cannot exceed 90%.', code: 'COUPON_PERCENT' });
    }
    const productIds = parseProductIds(body.productIds);
    if (productIds.length) {
      const owned = await Product.countDocuments({
        _id: { $in: productIds },
        creator: req.user._id,
      });
      if (owned !== productIds.length && req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Can only attach your own products.', code: 'COUPON_PRODUCTS' });
      }
    }
    const exists = await Coupon.findOne({ seller: req.user._id, code });
    if (exists) return res.status(409).json({ message: 'You already have this code.', code: 'COUPON_DUP' });

    const coupon = await Coupon.create({
      seller: req.user._id,
      code,
      type,
      value,
      productIds,
      minSubtotal: Math.max(0, Number(body.minSubtotal) || 0),
      maxDiscount: Math.max(0, Number(body.maxDiscount) || 0),
      startsAt: body.startsAt ? new Date(body.startsAt) : null,
      endsAt: body.endsAt ? new Date(body.endsAt) : null,
      maxUses: Math.max(0, Math.floor(Number(body.maxUses) || 0)),
      maxUsesPerBuyer: Math.max(0, Math.floor(Number(body.maxUsesPerBuyer ?? 1))),
      active: body.active !== false,
    });
    res.status(201).json(mapCoupon(coupon));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) return res.status(404).json({ message: 'Not found' });
    if (req.user.role !== 'admin' && String(coupon.seller) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const body = req.body || {};
    if (body.type === 'percent' || body.type === 'amount') coupon.type = body.type;
    if (body.value !== undefined) {
      const value = Number(body.value);
      if (!(value > 0)) return res.status(400).json({ message: 'Discount value required.', code: 'COUPON_VALUE' });
      if ((body.type || coupon.type) === 'percent' && value > 90) {
        return res.status(400).json({ message: 'Percent discount cannot exceed 90%.', code: 'COUPON_PERCENT' });
      }
      coupon.value = value;
    }
    if (body.productIds !== undefined) coupon.productIds = parseProductIds(body.productIds);
    if (body.minSubtotal !== undefined) coupon.minSubtotal = Math.max(0, Number(body.minSubtotal) || 0);
    if (body.maxDiscount !== undefined) coupon.maxDiscount = Math.max(0, Number(body.maxDiscount) || 0);
    if (body.startsAt !== undefined) coupon.startsAt = body.startsAt ? new Date(body.startsAt) : null;
    if (body.endsAt !== undefined) coupon.endsAt = body.endsAt ? new Date(body.endsAt) : null;
    if (body.maxUses !== undefined) coupon.maxUses = Math.max(0, Math.floor(Number(body.maxUses) || 0));
    if (body.maxUsesPerBuyer !== undefined) {
      coupon.maxUsesPerBuyer = Math.max(0, Math.floor(Number(body.maxUsesPerBuyer) || 0));
    }
    if (body.active !== undefined) coupon.active = !!body.active;
    await coupon.save();
    res.json(mapCoupon(coupon));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) return res.status(404).json({ message: 'Not found' });
    if (req.user.role !== 'admin' && String(coupon.seller) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    coupon.active = false;
    await coupon.save();
    res.json(mapCoupon(coupon));
  } catch (err) {
    next(err);
  }
});

router.post('/preview', authenticate, async (req, res, next) => {
  try {
    const productId = req.body?.productId;
    const code = req.body?.code;
    if (!productId || !code) return res.status(400).json({ message: 'productId and code required' });
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const quantity = clampQty(req.body?.quantity);
    const unit = unitForProduct(product, req.body?.licenseTerm);
    const subtotal = Math.round(unit * quantity * 100) / 100;
    const preview = await previewCoupon({
      code,
      product,
      buyerId: req.user._id,
      subtotal,
    });
    res.json({
      ok: true,
      code: preview.code,
      type: preview.coupon.type,
      value: preview.coupon.value,
      subtotal,
      discount: preview.discount,
      total: preview.total,
      currency: product.pricing?.currency || 'USD',
    });
  } catch (err) {
    if (err.code && err.status) {
      return res.status(err.status).json({ message: err.message, code: err.code });
    }
    next(err);
  }
});

module.exports = router;
