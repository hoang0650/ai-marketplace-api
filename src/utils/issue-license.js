const LicenseKey = require('../models/LicenseKey');
const {
  generateLicenseKey,
  expiresAtFrom,
  effectiveLicenseStatus,
  isLicenseCategory,
} = require('../utils/license-keys');

async function issueLicenseForOrder({ order, product, term }) {
  if (!isLicenseCategory(product?.category || order?.contractSnapshot?.category)) {
    return null;
  }
  const startsAt = new Date();
  const licenseTerm = term || 'month';
  const doc = await LicenseKey.create({
    licenseKey: generateLicenseKey(),
    order: order._id,
    product: product._id || order.product,
    productName: product.name || order.productName,
    buyer: order.buyer,
    seller: order.seller,
    category: product.category || '',
    term: licenseTerm,
    startsAt,
    expiresAt: expiresAtFrom(startsAt, licenseTerm),
    status: 'active',
  });
  return doc;
}

async function revokeLicensesForOrder(orderId) {
  await LicenseKey.updateMany(
    { order: orderId, status: 'active' },
    { $set: { status: 'revoked' } },
  );
}

function mapLicense(doc, now = new Date()) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  const status = effectiveLicenseStatus(o, now);
  return {
    id: String(o._id || o.id),
    licenseKey: o.licenseKey,
    orderId: String(o.order?._id || o.order),
    productId: String(o.product?._id || o.product),
    productName: o.productName || '',
    category: o.category || '',
    term: o.term,
    startsAt: o.startsAt ? new Date(o.startsAt).toISOString() : null,
    expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null,
    status,
    lastValidatedAt: o.lastValidatedAt ? new Date(o.lastValidatedAt).toISOString() : null,
    valid: status === 'active',
  };
}

module.exports = { issueLicenseForOrder, revokeLicensesForOrder, mapLicense };
