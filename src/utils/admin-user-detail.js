const SellerProfile = require('../models/SellerProfile');
const Product = require('../models/Product');
const Order = require('../models/Order');
const LicenseKey = require('../models/LicenseKey');
const WalletTx = require('../models/WalletTx');
const { getAvailableBalance } = require('./wallet');
const { mapKyc } = require('./kyc');
const { getAuthSession } = require('../middleware/auth');
const { resolveAdminPhone } = require('./admin-phone');

function iso(d) {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

async function buildAdminUserDetail(u, base) {
  const id = u._id;
  const [productCount, orderCount, licenseCount, disputeCount, walletAgg, wallet, shop, products, orders, licenses, disputes, session] =
    await Promise.all([
      Product.countDocuments({ creator: id }),
      Order.countDocuments({ $or: [{ buyer: id }, { seller: id }] }),
      LicenseKey.countDocuments({ $or: [{ buyer: id }, { seller: id }] }),
      Order.countDocuments({ disputeStatus: { $ne: 'none' }, $or: [{ buyer: id }, { seller: id }] }),
      WalletTx.aggregate([
        { $match: { user: id, status: { $nin: ['pending', 'failed', 'cancelled'] } } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
      getAvailableBalance(id).catch(() => ({ balance: 0, held: 0, available: 0 })),
      SellerProfile.findOne({ user: id }).lean(),
      Product.find({ creator: id })
        .select('name slug published moderationStatus salesCount createdAt')
        .sort({ createdAt: -1 })
        .limit(12)
        .lean(),
      Order.find({ $or: [{ buyer: id }, { seller: id }] })
        .select('productName amount currency status disputeStatus buyer seller createdAt')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      LicenseKey.find({ $or: [{ buyer: id }, { seller: id }] })
        .select('productName term status expiresAt licenseKey buyer seller createdAt')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Order.find({ disputeStatus: { $ne: 'none' }, $or: [{ buyer: id }, { seller: id }] })
        .select('productName amount currency disputeStatus disputeOutcome disputeOpenedAt buyer seller')
        .sort({ disputeOpenedAt: -1 })
        .limit(8)
        .lean(),
      getAuthSession(id),
    ]);

  const slug = u.creatorSlug || '';
  const phone = resolveAdminPhone({ sellerProfile: shop });
  const kyc = mapKyc(u);
  const affiliateActive = !!(u.affiliateCode || u.affiliateClicks || u.affiliateConversions || u.affiliateEarnings);
  const side = (doc) => (String(doc.buyer) === String(id) ? 'buyer' : 'seller');

  return {
    ...base,
    productCount,
    orderCount,
    licenseCount,
    disputeCount,
    walletByType: Object.fromEntries((walletAgg || []).map((w) => [w._id, w.total])),
    phone,
    kyc,
    kycStatus: kyc.status,
    wallet: {
      balance: wallet.balance || 0,
      held: wallet.held || 0,
      available: wallet.available || 0,
      currency: 'USD',
    },
    lastLoginAt: iso(u.lastLoginAt) || (session && session.lastLogin) || null,
    links: {
      admin: `/admin/users/${id}`,
      shop: slug ? `/store/${slug}` : null,
    },
    shop: shop
      ? {
          id: String(shop._id),
          sellerType: shop.sellerType || '',
          legalName: shop.legalName || '',
          displayName: shop.displayName || '',
          contactEmail: shop.contactEmail || '',
          contactPhone: shop.contactPhone || '',
          verificationStatus: shop.verificationStatus || '',
          identityVerificationStatus: shop.identityVerificationStatus || 'none',
          href: slug ? `/store/${slug}` : null,
        }
      : null,
    products: products.map((p) => ({
      id: String(p._id),
      name: p.name,
      slug: p.slug,
      published: p.published !== false,
      moderationStatus: p.moderationStatus || 'active',
      salesCount: Number(p.salesCount) || 0,
      createdAt: p.createdAt || null,
      href: p.slug ? `/product/${p.slug}` : null,
      adminHref: `/admin/products/${p._id}`,
    })),
    recentOrders: orders.map((o) => ({
      id: String(o._id),
      productName: o.productName,
      amount: o.amount,
      currency: o.currency || 'USD',
      status: o.status,
      disputeStatus: o.disputeStatus || 'none',
      side: side(o),
      createdAt: o.createdAt || null,
      href: `/orders/${o._id}`,
    })),
    licenses: licenses.map((lic) => ({
      id: String(lic._id),
      productName: lic.productName || '',
      term: lic.term,
      status: lic.status,
      expiresAt: lic.expiresAt || null,
      licenseKeyMasked: maskKey(lic.licenseKey),
      side: String(lic.buyer) === String(id) ? 'buyer' : 'seller',
      createdAt: lic.createdAt || null,
    })),
    disputes: disputes.map((o) => ({
      id: String(o._id),
      productName: o.productName,
      amount: o.amount,
      currency: o.currency || 'USD',
      disputeStatus: o.disputeStatus,
      disputeOutcome: o.disputeOutcome || '',
      side: side(o),
      disputeOpenedAt: o.disputeOpenedAt || null,
      href: `/admin/disputes/${o._id}`,
    })),
    affiliate: affiliateActive
      ? {
          code: u.affiliateCode || '',
          clicks: Number(u.affiliateClicks) || 0,
          conversions: Number(u.affiliateConversions) || 0,
          earnings: Number(u.affiliateEarnings) || 0,
          pitStatus: u.pitCommitment?.status || 'none',
          pitYear: u.pitCommitment?.year || null,
        }
      : null,
  };
}

module.exports = { buildAdminUserDetail };
