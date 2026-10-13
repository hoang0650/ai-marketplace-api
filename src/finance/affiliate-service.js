const mongoose = require('mongoose');
const AffiliateClick = require('../models/AffiliateClick');
const AffiliateCommission = require('../models/AffiliateCommission');
const Order = require('../models/Order');
const User = require('../models/User');
const WalletTx = require('../models/WalletTx');
const { roundMoney } = require('./constants');
const { calculateAffiliateCommission } = require('./affiliate-engine');
const { affiliateConfig } = require('../config/affiliate');
const { isPitCommitmentApproved } = require('../utils/pit-commitment');
const { recordAdjustmentLines, newEntryId } = require('./ledger-service');

const DAY_MS = 24 * 60 * 60 * 1000;
const sid = (v) => (v ? String(v._id || v) : '');

/**
 * Pure last-click decision. A click qualifies when it is inside the window, points at this product
 * (product link) or at its seller (store link), and the affiliate is neither the buyer nor the seller.
 * The newest qualifying click wins.
 */
function pickAttribution(clicks, { buyerId, product, now = new Date(), windowDays } = {}) {
  const days = windowDays || affiliateConfig().attributionDays;
  const since = now.getTime() - days * DAY_MS;
  const sellerId = sid(product?.creator);
  const productId = sid(product?._id || product?.id);
  const rejected = [];
  const ok = [];
  for (const c of clicks || []) {
    if (!c) continue;
    const at = new Date(c.createdAt || 0).getTime();
    const aff = sid(c.affiliate);
    let reason = '';
    if (!(at >= since && at <= now.getTime() + 60_000)) reason = 'EXPIRED';
    else if (aff && aff === sid(buyerId)) reason = 'SELF_REFERRAL_BUYER';
    else if (aff && aff === sellerId) reason = 'SELF_REFERRAL_SELLER';
    else if (c.scope === 'product' && sid(c.product) !== productId) reason = 'OTHER_PRODUCT';
    else if (sid(c.seller) !== sellerId) reason = 'OTHER_STORE';
    if (reason) rejected.push({ clickId: sid(c._id), reason });
    else ok.push(c);
  }
  ok.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { click: ok[0] || null, rejected };
}

/** Candidate clicks: the one from the visitor's cookie plus the signed-in buyer's own recent clicks. */
async function resolveAttribution({ buyerId, product, clickId, now = new Date() }) {
  const cfg = affiliateConfig();
  const since = new Date(now.getTime() - cfg.attributionDays * DAY_MS);
  const or = [{ visitor: buyerId, createdAt: { $gte: since } }];
  if (clickId && mongoose.Types.ObjectId.isValid(String(clickId))) or.push({ _id: clickId });
  const clicks = await AffiliateClick.find({ $or: or }).sort({ createdAt: -1 }).limit(50).lean();
  const picked = pickAttribution(clicks, { buyerId, product, now, windowDays: cfg.attributionDays });
  if (!picked.click) return { click: null, rejected: picked.rejected };
  const affiliate = await User.findById(picked.click.affiliate).select('_id affiliateCode accountStatus kyc.status').lean();
  if (!affiliate || (affiliate.accountStatus && affiliate.accountStatus !== 'active') || affiliate.kyc?.status !== 'verified') {
    return { click: null, rejected: [...picked.rejected, { clickId: sid(picked.click._id), reason: 'AFFILIATE_INACTIVE' }] };
  }
  return { click: picked.click, affiliate, rejected: picked.rejected };
}

/** Credit the affiliate (net of PIT) and write ledger lines. Idempotent per order. */
async function recordAffiliateCommission({ order, settlement, click, holdUntil }) {
  if (!click || !(settlement.affiliateCommissionAmount > 0)) return null;
  const existing = await AffiliateCommission.findOne({ order: order._id });
  if (existing) return existing;
  const affiliateUser = await User.findById(click.affiliate).select('pitCommitment').lean().catch(() => null);
  const pitCommitmentApproved = isPitCommitmentApproved(affiliateUser, order.createdAt || new Date());
  const calc = calculateAffiliateCommission({
    baseAmount: settlement.grossAmount,
    rate: settlement.affiliateRate,
    currency: order.currency,
    pitCommitmentApproved,
  });
  const commission = await AffiliateCommission.create({
    order: order._id,
    affiliate: click.affiliate,
    seller: order.seller,
    buyer: order.buyer,
    product: order.product,
    productName: order.productName || '',
    click: click._id,
    code: click.code,
    currency: order.currency || 'USD',
    baseAmount: calc.baseAmount,
    rate: calc.rate,
    amount: calc.amount,
    pitRate: calc.pitRate,
    pitAmount: calc.pitAmount,
    pitRule: calc.pitRule,
    amountVnd: calc.amountVnd,
    pitCommitmentApplied: calc.pitRule === 'EXEMPT_CAM_KET_08_CK_TNCN',
    netAmount: calc.netAmount,
    holdUntil,
  });
  if (calc.netAmount > 0) {
    await WalletTx.create({
      user: click.affiliate,
      type: 'credit',
      amount: calc.netAmount,
      currency: order.currency || 'USD',
      note: `Affiliate commission ${Math.round(calc.rate * 1000) / 10}% · order ${order._id}${calc.pitAmount ? ` (PIT withheld ${calc.pitAmount})` : ''}`,
    });
  }
  const extra = [
    {
      entryId: `ord_${order._id}_affiliate_commission`,
      type: 'AFFILIATE_COMMISSION',
      amount: calc.amount,
      direction: 'credit',
      reference: `order:${order._id}:affiliate-commission`,
      meta: { affiliate: sid(click.affiliate), rate: calc.rate, pitAmount: calc.pitAmount },
    },
  ];
  if (calc.pitAmount > 0) {
    extra.push({
      entryId: `ord_${order._id}_affiliate_pit`,
      type: 'TAX_PAYABLE',
      amount: calc.pitAmount,
      direction: 'credit',
      reference: `order:${order._id}:affiliate-pit`,
      meta: { pitRule: calc.pitRule, pitRate: calc.pitRate, affiliate: sid(click.affiliate) },
    });
  }
  await recordAdjustmentLines({ order, extra }).catch((err) => console.error('[affiliate ledger]', err.message));
  await User.updateOne({ _id: click.affiliate }, { $inc: { affiliateConversions: 1, affiliateEarnings: calc.netAmount } }).catch(() => {});
  return commission;
}

/**
 * Claw back `ratio` (0–1) of an order's commission: refunds, cancellations, buyer-won disputes,
 * or fraud. Debits the affiliate wallet (may go negative only by what was already credited).
 */
async function reverseAffiliateCommission({ orderId, ratio = 1, reason = 'refund' }) {
  const c = await AffiliateCommission.findOne({ order: orderId });
  if (!c || c.status === 'reversed') return null;
  const remaining = roundMoney(c.netAmount - (c.reversedAmount || 0));
  if (remaining <= 0) return null;
  const share = Math.max(0, Math.min(1, Number(ratio) || 0));
  const clawNet = share >= 1 ? remaining : Math.min(remaining, roundMoney(c.netAmount * share));
  if (clawNet <= 0) return null;
  c.reversedAmount = roundMoney((c.reversedAmount || 0) + clawNet);
  if (c.reversedAmount + 1e-9 >= c.netAmount) c.status = 'reversed';
  c.reversedAt = new Date();
  c.reversalReason = String(reason).slice(0, 300);
  await c.save();
  await WalletTx.create({
    user: c.affiliate,
    type: 'debit',
    amount: clawNet,
    currency: c.currency,
    note: `Affiliate commission reversed (${c.reversalReason}) · order ${orderId}`,
  });
  const grossShare = c.netAmount > 0 ? clawNet / c.netAmount : 1;
  const order = await Order.findById(orderId).lean();
  if (order) {
    const extra = [
      {
        entryId: newEntryId('aff_rev'),
        type: 'AFFILIATE_COMMISSION',
        amount: roundMoney(c.amount * grossShare),
        direction: 'debit',
        reference: `order:${orderId}:affiliate-reversal`,
        meta: { reason: c.reversalReason },
      },
    ];
    if (c.pitAmount > 0) {
      extra.push({
        entryId: newEntryId('aff_pit_rev'),
        type: 'TAX_PAYABLE',
        amount: roundMoney(c.pitAmount * grossShare),
        direction: 'debit',
        reference: `order:${orderId}:affiliate-pit-reversal`,
      });
    }
    await recordAdjustmentLines({ order, extra }).catch((err) => console.error('[affiliate ledger]', err.message));
  }
  await User.updateOne({ _id: c.affiliate }, { $inc: { affiliateEarnings: -clawNet } }).catch(() => {});
  return { commission: c, clawNet };
}

/** Held = active commissions still inside the 48h window, or whose order has an open dispute. */
function isCommissionHeld(c, order, now = new Date()) {
  if (c.status !== 'active') return false;
  if (roundMoney(c.netAmount - (c.reversedAmount || 0)) <= 0) return false;
  if ((order?.disputeStatus || 'none') === 'open') return true;
  return now < new Date(c.holdUntil);
}

async function getAffiliateHolds(userId, now = new Date()) {
  const rows = await AffiliateCommission.find({ affiliate: userId, status: 'active' }).lean();
  if (!rows.length) return { held: 0, holds: [] };
  const orders = await Order.find({ _id: { $in: rows.map((r) => r.order) } })
    .select('_id disputeStatus')
    .lean();
  const byId = new Map(orders.map((o) => [String(o._id), o]));
  let held = 0;
  const holds = [];
  for (const c of rows) {
    const o = byId.get(String(c.order));
    if (!isCommissionHeld(c, o, now)) continue;
    const amount = roundMoney(c.netAmount - (c.reversedAmount || 0));
    held += amount;
    holds.push({
      orderId: String(c.order),
      productName: `Affiliate · ${c.productName}`,
      amount,
      currency: c.currency,
      kind: (o?.disputeStatus || 'none') === 'open' ? 'dispute' : 'protection_window',
      holdUntil: new Date(c.holdUntil).toISOString(),
      disputeStatus: o?.disputeStatus || 'none',
      disputeReason: '',
      source: 'affiliate',
    });
  }
  return { held: roundMoney(held), holds };
}

module.exports = {
  pickAttribution,
  resolveAttribution,
  recordAffiliateCommission,
  reverseAffiliateCommission,
  isCommissionHeld,
  getAffiliateHolds,
};
