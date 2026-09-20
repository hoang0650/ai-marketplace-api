const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const { roundMoney } = require('../finance/constants');

function normalizeCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 24);
}

function couponError(message, code, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function mapCoupon(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  return {
    id: String(o._id || o.id),
    sellerId: o.seller ? String(o.seller._id || o.seller) : '',
    code: o.code,
    type: o.type,
    value: Number(o.value) || 0,
    productIds: (o.productIds || []).map((id) => String(id)),
    minSubtotal: Number(o.minSubtotal) || 0,
    maxDiscount: Number(o.maxDiscount) || 0,
    startsAt: o.startsAt ? new Date(o.startsAt).toISOString() : null,
    endsAt: o.endsAt ? new Date(o.endsAt).toISOString() : null,
    maxUses: Number(o.maxUses) || 0,
    maxUsesPerBuyer: Number(o.maxUsesPerBuyer) || 0,
    usedCount: Number(o.usedCount) || 0,
    active: o.active !== false,
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : null,
  };
}

function discountForSubtotal(coupon, subtotal) {
  const total = roundMoney(subtotal);
  if (!(total > 0)) return 0;
  let cut = 0;
  if (coupon.type === 'percent') {
    const pct = Math.min(90, Math.max(0, Number(coupon.value) || 0));
    cut = total * (pct / 100);
    const cap = Number(coupon.maxDiscount) || 0;
    if (cap > 0) cut = Math.min(cut, cap);
  } else {
    cut = Number(coupon.value) || 0;
  }
  return roundMoney(Math.min(Math.max(cut, 0), total));
}

async function assertCouponUsable(coupon, { product, buyerId, subtotal, now = new Date() }) {
  if (!coupon || coupon.active === false) {
    throw couponError('Coupon is not active.', 'COUPON_INACTIVE');
  }
  if (coupon.startsAt && new Date(coupon.startsAt) > now) {
    throw couponError('Coupon is not active yet.', 'COUPON_NOT_STARTED');
  }
  if (coupon.endsAt && new Date(coupon.endsAt) < now) {
    throw couponError('Coupon has expired.', 'COUPON_EXPIRED');
  }
  const ids = (coupon.productIds || []).map((id) => String(id));
  if (ids.length && !ids.includes(String(product._id || product.id))) {
    throw couponError('Coupon does not apply to this product.', 'COUPON_PRODUCT');
  }
  const min = Number(coupon.minSubtotal) || 0;
  if (min > 0 && subtotal < min) {
    throw couponError(`Order must be at least ${min.toFixed(2)} to use this coupon.`, 'COUPON_MIN');
  }
  const maxUses = Number(coupon.maxUses) || 0;
  if (maxUses > 0 && Number(coupon.usedCount) >= maxUses) {
    throw couponError('Coupon has reached its usage limit.', 'COUPON_LIMIT');
  }
  const perBuyer = Number(coupon.maxUsesPerBuyer) || 0;
  if (perBuyer > 0 && buyerId) {
    const n = await CouponRedemption.countDocuments({ coupon: coupon._id, buyer: buyerId });
    if (n >= perBuyer) {
      throw couponError('You already used this coupon.', 'COUPON_USED');
    }
  }
}

async function previewCoupon({ code, product, buyerId, subtotal }) {
  const normalized = normalizeCode(code);
  if (!normalized) throw couponError('Coupon not found.', 'COUPON_NOT_FOUND', 404);
  const coupon = await Coupon.findOne({
    seller: product.creator,
    code: normalized,
  });
  if (!coupon) throw couponError('Coupon not found.', 'COUPON_NOT_FOUND', 404);
  await assertCouponUsable(coupon, { product, buyerId, subtotal });
  const discount = discountForSubtotal(coupon, subtotal);
  if (!(discount > 0)) throw couponError('Coupon does not reduce this order.', 'COUPON_ZERO');
  return {
    coupon,
    code: coupon.code,
    discount,
    total: roundMoney(subtotal - discount),
  };
}

async function consumeCoupon({ coupon, buyerId, orderId, productId, discount }) {
  const filter = { _id: coupon._id, active: true };
  const maxUses = Number(coupon.maxUses) || 0;
  if (maxUses > 0) filter.usedCount = { $lt: maxUses };
  const updated = await Coupon.findOneAndUpdate(filter, { $inc: { usedCount: 1 } }, { new: true });
  if (!updated) throw couponError('Coupon has reached its usage limit.', 'COUPON_LIMIT');
  await CouponRedemption.create({
    coupon: coupon._id,
    seller: coupon.seller,
    buyer: buyerId,
    order: orderId || null,
    product: productId || null,
    code: coupon.code,
    discount,
  });
  return updated;
}

function parseProductIds(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((id) => String(id || '').trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .slice(0, 50);
}

module.exports = {
  normalizeCode,
  mapCoupon,
  discountForSubtotal,
  assertCouponUsable,
  previewCoupon,
  consumeCoupon,
  parseProductIds,
  couponError,
};
