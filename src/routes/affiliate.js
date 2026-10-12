const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Product = require('../models/Product');
const SellerProfile = require('../models/SellerProfile');
const AffiliateClick = require('../models/AffiliateClick');
const AffiliateCommission = require('../models/AffiliateCommission');
const config = require('../config/env');
const { affiliateConfig } = require('../config/affiliate');
const { authenticate, optionalAuth, requireRoles, invalidateAuthUserCache } = require('../middleware/auth');
const { parseAffiliateRate, effectiveAffiliateRate } = require('../finance/affiliate-engine');
const { isCommissionHeld, reverseAffiliateCommission } = require('../finance/affiliate-service');
const { roundMoney } = require('../finance/constants');
const { deleteCachePattern } = require('../utils/cache');
const { writeAuditLog } = require('../utils/audit');

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;
/** Repeat visits of one link from one device within this window count as one click. */
const CLICK_DEDUPE_MS = 30 * 60 * 1000;

function publicConfig() {
  const cfg = affiliateConfig();
  return {
    attributionDays: cfg.attributionDays,
    maxRate: cfg.maxRate,
    attribution: 'last_click',
    holdHours: Number(process.env.PAYOUT_HOLD_HOURS || 48),
    pit: { enabled: cfg.pit.enabled, rate: cfg.pit.rate, thresholdVnd: cfg.pit.thresholdVnd, legalReview: true },
  };
}

const isKycVerified = (user) => user?.kyc?.status === 'verified';

const KYC_REQUIRED = {
  code: 'KYC_REQUIRED',
  message: 'Hoàn tất xác minh danh tính (eKYC) trước khi tạo liên kết affiliate.',
};

/** Creates the affiliate code only for eKYC-verified users; unverified users get no code. */
async function ensureCode(userId) {
  const user = await User.findById(userId);
  if (!user) return null;
  if (!isKycVerified(user)) return user;
  if (!user.affiliateCode) {
    let code = `PHAI-${String(user.name || 'USER').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase() || 'USER'}`;
    if (await User.exists({ affiliateCode: code, _id: { $ne: user._id } })) {
      code = `${code}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    }
    user.affiliateCode = code;
    await user.save();
    await invalidateAuthUserCache(user._id);
  }
  return user;
}

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));

async function findTarget({ productId, productSlug, storeSlug }) {
  if (productId || productSlug) {
    const product = await Product.findOne(isId(productId) ? { _id: productId } : { slug: String(productSlug || '').toLowerCase() })
      .select('_id slug name creator creatorSlug ownershipType affiliateRate')
      .lean();
    if (!product) return null;
    return { scope: 'product', product, sellerId: product.creator, slug: product.slug, storeSlug: product.creatorSlug };
  }
  if (storeSlug) {
    const seller = await User.findOne({ creatorSlug: String(storeSlug).toLowerCase() }).select('_id creatorSlug').lean();
    if (!seller) return null;
    return { scope: 'store', product: null, sellerId: seller._id, storeSlug: seller.creatorSlug };
  }
  return null;
}

function buildLink(target, code) {
  const base = config.frontendUrl.replace(/\/$/, '');
  const path = target.scope === 'product' ? `/product/${target.slug}` : `/store/${target.storeSlug}`;
  return { path: `${path}?ref=${encodeURIComponent(code)}`, url: `${base}${path}?ref=${encodeURIComponent(code)}` };
}

function summarize(rows, ordersById, now = new Date()) {
  let pending = 0;
  let available = 0;
  let reversed = 0;
  let pit = 0;
  for (const c of rows) {
    const live = roundMoney(c.netAmount - (c.reversedAmount || 0));
    reversed += c.reversedAmount || 0;
    if (c.status === 'active') pit += c.pitAmount || 0;
    if (live <= 0) continue;
    if (isCommissionHeld(c, ordersById.get(String(c.order)), now)) pending += live;
    else available += live;
  }
  return {
    pending: roundMoney(pending),
    available: roundMoney(available),
    reversed: roundMoney(reversed),
    pitWithheld: roundMoney(pit),
    total: roundMoney(pending + available),
  };
}

function mapCommission(c, order, now = new Date()) {
  const live = roundMoney(c.netAmount - (c.reversedAmount || 0));
  return {
    id: String(c._id),
    orderId: String(c.order),
    productId: String(c.product),
    productName: c.productName,
    currency: c.currency,
    baseAmount: c.baseAmount,
    rate: c.rate,
    amount: c.amount,
    pitAmount: c.pitAmount,
    netAmount: c.netAmount,
    reversedAmount: c.reversedAmount || 0,
    state: c.status === 'reversed' || live <= 0 ? 'reversed' : isCommissionHeld(c, order, now) ? 'pending' : 'available',
    holdUntil: c.holdUntil,
    createdAt: c.createdAt,
  };
}

router.get('/config', (_req, res) => res.json(publicConfig()));

/** The signed-in user's affiliate dashboard. A code and links require eKYC (verified) first. */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const user = await ensureCode(req.user._id);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    const [clicks, rows] = await Promise.all([
      AffiliateClick.countDocuments({ affiliate: user._id }),
      AffiliateCommission.find({ affiliate: user._id }).sort({ createdAt: -1 }).lean(),
    ]);
    const Order = require('../models/Order');
    const orders = await Order.find({ _id: { $in: rows.map((r) => r.order) } }).select('_id disputeStatus').lean();
    const byId = new Map(orders.map((o) => [String(o._id), o]));
    const commission = summarize(rows, byId);
    const kycStatus = user.kyc?.status || 'none';
    res.json({
      code: kycStatus === 'verified' ? user.affiliateCode : null,
      kycStatus,
      kycRequired: kycStatus !== 'verified',
      linkReady: kycStatus === 'verified',
      payoutReady: kycStatus === 'verified',
      clicks,
      orders: rows.filter((r) => r.status === 'active').length,
      conversions: rows.filter((r) => r.status === 'active').length,
      commission,
      earnings: commission.total,
      currency: rows[0]?.currency || 'USD',
      recent: rows.slice(0, 50).map((c) => mapCommission(c, byId.get(String(c.order)))),
      config: publicConfig(),
    });
  } catch (err) {
    next(err);
  }
});

/** Referral link for one product or one store. Only eKYC-verified users can create one (403 KYC_REQUIRED). */
router.get('/link', authenticate, async (req, res, next) => {
  try {
    const user = await ensureCode(req.user._id);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (!isKycVerified(user)) return res.status(403).json(KYC_REQUIRED);
    const target = await findTarget({
      productId: req.query.productId,
      productSlug: req.query.productSlug,
      storeSlug: req.query.storeSlug,
    });
    if (!target) return res.status(404).json({ message: 'Product or store not found' });
    if (String(target.sellerId) === String(user._id)) {
      return res.status(400).json({ message: 'You cannot refer your own products.', code: 'SELF_REFERRAL' });
    }
    let rate = 0;
    if (target.product) {
      const profile = await SellerProfile.findOne({ user: target.sellerId }).select('affiliateDefaultRate').lean();
      rate = (target.product.ownershipType || 'THIRD_PARTY_SELLER') === 'THIRD_PARTY_SELLER'
        ? effectiveAffiliateRate(target.product, profile)
        : 0;
    } else {
      const profile = await SellerProfile.findOne({ user: target.sellerId }).select('affiliateDefaultRate').lean();
      const max = await Product.find({ creator: target.sellerId, affiliateRate: { $gt: 0 } })
        .sort({ affiliateRate: -1 })
        .limit(1)
        .select('affiliateRate')
        .lean();
      rate = Math.max(Number(profile?.affiliateDefaultRate) || 0, Number(max[0]?.affiliateRate) || 0);
    }
    res.json({ code: user.affiliateCode, scope: target.scope, rate, inProgram: rate > 0, ...buildLink(target, user.affiliateCode) });
  } catch (err) {
    next(err);
  }
});

/**
 * Record a referral-link visit (web/app call this when a `?ref=` URL opens). Returns a click id
 * the client keeps for `attributionDays` and sends with checkout as `affiliateClickId`.
 */
router.post('/click', optionalAuth, async (req, res, next) => {
  try {
    const cfg = affiliateConfig();
    const code = String(req.body?.code || '').trim().slice(0, 64);
    if (!code) return res.status(400).json({ message: 'code required' });
    const affiliate = await User.findOne({ affiliateCode: code }).select('_id accountStatus kyc.status').lean();
    if (!affiliate || (affiliate.accountStatus && affiliate.accountStatus !== 'active')) {
      return res.json({ ok: false, reason: 'UNKNOWN_CODE' });
    }
    if (!isKycVerified(affiliate)) {
      return res.json({ ok: false, reason: 'AFFILIATE_NOT_VERIFIED' });
    }
    const target = await findTarget({
      productId: req.body?.productId,
      productSlug: req.body?.productSlug,
      storeSlug: req.body?.storeSlug,
    });
    if (!target) return res.json({ ok: false, reason: 'UNKNOWN_TARGET' });
    const visitor = req.user?._id || null;
    if (String(target.sellerId) === String(affiliate._id) || (visitor && String(visitor) === String(affiliate._id))) {
      return res.json({ ok: false, reason: 'SELF_REFERRAL' });
    }
    const ipHash = crypto
      .createHash('sha256')
      .update(`${req.ip || ''}|${req.get('user-agent') || ''}`)
      .digest('hex')
      .slice(0, 32);
    const recent = await AffiliateClick.findOne({
      affiliate: affiliate._id,
      ipHash,
      product: target.product?._id || null,
      seller: target.sellerId,
      createdAt: { $gte: new Date(Date.now() - CLICK_DEDUPE_MS) },
    }).lean();
    let click = recent;
    if (!click) {
      click = await AffiliateClick.create({
        affiliate: affiliate._id,
        code,
        scope: target.scope,
        product: target.product?._id || null,
        seller: target.sellerId,
        visitor,
        ipHash,
        userAgent: String(req.get('user-agent') || '').slice(0, 300),
        landing: String(req.body?.landing || '').slice(0, 500),
      });
      await User.updateOne({ _id: affiliate._id }, { $inc: { affiliateClicks: 1 } }).catch(() => {});
    } else if (visitor && !click.visitor) {
      await AffiliateClick.updateOne({ _id: click._id }, { $set: { visitor } });
    }
    res.json({
      ok: true,
      clickId: String(click._id),
      attributionDays: cfg.attributionDays,
      expiresAt: new Date(new Date(click.createdAt).getTime() + cfg.attributionDays * DAY_MS).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/** Seller: store default rate, per-product rates and affiliate sales. */
router.get('/seller', authenticate, async (req, res, next) => {
  try {
    const sellerId = req.user._id;
    const [profile, products, rows] = await Promise.all([
      SellerProfile.findOne({ user: sellerId }).select('affiliateDefaultRate').lean(),
      Product.find({ creator: sellerId }).select('_id name slug affiliateRate ownershipType').lean(),
      AffiliateCommission.find({ seller: sellerId }).lean(),
    ]);
    const per = new Map();
    let totalOrders = 0;
    let totalCommission = 0;
    let totalSales = 0;
    for (const c of rows) {
      if (c.status !== 'active') continue;
      const k = String(c.product);
      const cur = per.get(k) || { orders: 0, sales: 0, commission: 0 };
      cur.orders += 1;
      cur.sales = roundMoney(cur.sales + c.baseAmount);
      cur.commission = roundMoney(cur.commission + c.amount);
      per.set(k, cur);
      totalOrders += 1;
      totalSales += c.baseAmount;
      totalCommission += c.amount;
    }
    const clicks = await AffiliateClick.countDocuments({ seller: sellerId });
    res.json({
      defaultRate: Number(profile?.affiliateDefaultRate) || 0,
      maxRate: affiliateConfig().maxRate,
      clicks,
      orders: totalOrders,
      sales: roundMoney(totalSales),
      commission: roundMoney(totalCommission),
      currency: rows[0]?.currency || 'USD',
      products: products.map((p) => ({
        id: String(p._id),
        name: p.name,
        slug: p.slug,
        affiliateRate: p.affiliateRate ?? null,
        effectiveRate: effectiveAffiliateRate(p, profile),
        ...(per.get(String(p._id)) || { orders: 0, sales: 0, commission: 0 }),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Seller: store-wide default (0 = not in the program). New orders only. */
router.put('/seller/default-rate', authenticate, requireRoles('seller', 'talent', 'admin'), async (req, res, next) => {
  try {
    const parsed = parseAffiliateRate(req.body?.rate);
    if (!parsed.ok) return res.status(400).json({ message: parsed.message, code: parsed.code });
    const profile = await SellerProfile.findOneAndUpdate(
      { user: req.user._id },
      { $set: { affiliateDefaultRate: parsed.rate } },
      { new: true },
    ).lean();
    if (!profile) return res.status(400).json({ message: 'Seller profile required', code: 'SELLER_PROFILE_REQUIRED' });
    deleteCachePattern('products:*').catch(() => {});
    res.json({ defaultRate: profile.affiliateDefaultRate });
  } catch (err) {
    next(err);
  }
});

/** Admin: claw back a commission for fraud (fake orders, cookie stuffing, self-referral…). */
router.post('/admin/commissions/:orderId/clawback', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    if (!isId(req.params.orderId)) return res.status(400).json({ message: 'Invalid order id' });
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ message: 'reason required' });
    const result = await reverseAffiliateCommission({ orderId: req.params.orderId, ratio: 1, reason: `fraud: ${reason}` });
    if (!result) return res.status(404).json({ message: 'No active commission for this order' });
    await writeAuditLog({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: 'AFFILIATE_CLAWBACK',
      resourceType: 'AffiliateCommission',
      resourceId: result.commission._id,
      newValue: { orderId: req.params.orderId, clawNet: result.clawNet },
      reason,
    });
    res.json({ ok: true, clawNet: result.clawNet, status: result.commission.status });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
