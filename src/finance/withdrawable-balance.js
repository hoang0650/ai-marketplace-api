const { roundMoney, effectiveSellerNet, isPayoutHeld, HOLD_MS } = require('../utils/payout-hold');

const SALE_CREDIT = /^Seller payable:|\(seller payable after commission\/tax\)$/;
const CLAWBACK = /^(Refund clawback|Chargeback)\b/;

const PREPAID_MESSAGE =
  'Topped-up and prepaid marketplace credit cannot be withdrawn or transferred. Only approved seller earnings or affiliate commissions can be paid out.';
const BUYER_MESSAGE =
  'Buyer prepaid credit cannot be withdrawn or transferred. Eligible refund requests are handled separately under the refund policy.';

/**
 * Seller/talent earnings that are eligible to leave the pooled wallet.
 * Sources are order snapshots, usage events, refund/chargeback clawbacks, reviewed
 * adjustments, and non-affiliate withdrawals. Deposits and buyer refund credits are not earnings.
 * Legacy withdrawals with no persona are counted here: the pooled ledger does not record
 * whether that cashout took earnings or a top-up.
 */
function sellerEarnedAvailable({ orders = [], usage = [], walletTxs = [], now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  let earned = 0;
  let held = 0;
  for (const order of orders) {
    if ((order.ownershipType || 'THIRD_PARTY_SELLER') === 'PLATFORM_DIRECT') continue;
    if (!['paid', 'refunded', 'completed'].includes(order.status || '')) continue;
    const net = effectiveSellerNet(order);
    if (!(net > 0)) continue;
    earned += net;
    if (isPayoutHeld(order, at)) held += net;
  }
  for (const event of usage) {
    const net = Number(event.sellerNet) || 0;
    if (!(net > 0)) continue;
    earned += net;
    const created = new Date(event.createdAt).getTime();
    if (Number.isFinite(created) && at.getTime() < created + HOLD_MS) held += net;
  }
  let clawback = 0;
  let withdrawn = 0;
  let adjustment = 0;
  for (const tx of walletTxs) {
    const status = tx.status || 'completed';
    if (status === 'failed' || status === 'cancelled') continue;
    const amount = Number(tx.amount) || 0;
    if (tx.type === 'debit' && CLAWBACK.test(tx.note || '')) clawback += amount;
    else if (tx.type === 'withdraw' && tx.meta?.persona !== 'affiliate' && (status === 'completed' || status === 'pending')) {
      withdrawn += amount;
    } else if ((tx.type === 'credit' || tx.type === 'debit') && tx.reviewedBy && !SALE_CREDIT.test(tx.note || '')) {
      adjustment += tx.type === 'credit' ? amount : -amount;
    }
  }
  const available = Math.max(0, earned - held - clawback + adjustment - withdrawn);
  return {
    earned: roundMoney(earned),
    held: roundMoney(held),
    clawback: roundMoney(clawback),
    adjustment: roundMoney(adjustment),
    withdrawn: roundMoney(withdrawn),
    available: roundMoney(available),
  };
}

/**
 * Cap a cashout to money that has its own earnings evidence.
 * `poolAvailable` is the pooled ledger after holds. It is not itself proof of earnings.
 */
function payoutCap({ persona, amount, poolAvailable = 0, earnedAvailable = 0, affiliateAvailable = 0 } = {}) {
  const amt = Number(amount);
  const pool = Math.max(0, Number(poolAvailable) || 0);
  if (persona === 'buyer') {
    return { ok: false, code: 'BUYER_CREDIT_NON_WITHDRAWABLE', message: BUYER_MESSAGE, payable: 0 };
  }
  if (persona === 'affiliate') {
    const payable = roundMoney(Math.max(0, Math.min(pool, Number(affiliateAvailable) || 0)));
    if (!(amt > 0) || amt > payable + 1e-9) {
      return {
        ok: false,
        code: 'AFFILIATE_INSUFFICIENT',
        message: 'Amount exceeds the withdrawable affiliate balance.',
        payable,
      };
    }
    return { ok: true, code: null, message: null, payable };
  }
  const earned = Math.max(0, Number(earnedAvailable) || 0);
  const payable = roundMoney(Math.min(pool, earned));
  if (!(amt > 0) || amt > payable + 1e-9) {
    if (earned + 1e-9 < pool && amt > earned + 1e-9) {
      return { ok: false, code: 'PREPAID_NOT_WITHDRAWABLE', message: PREPAID_MESSAGE, payable: roundMoney(earned) };
    }
    if (amt > pool + 1e-9) {
      return { ok: false, code: 'PAYOUT_HELD', message: null, payable };
    }
    return { ok: false, code: 'PREPAID_NOT_WITHDRAWABLE', message: PREPAID_MESSAGE, payable };
  }
  return { ok: true, code: null, message: null, payable };
}

function summaryPayable({ persona, poolAvailable = 0, earnedAvailable = 0, affiliateAvailable = 0, walletBalance = 0 } = {}) {
  if (persona === 'buyer') {
    return { payableAmount: 0, payableCode: 'BUYER_CREDIT_NON_WITHDRAWABLE' };
  }
  if (persona === 'affiliate') {
    const payableAmount = roundMoney(Math.max(0, Math.min(Math.max(0, Number(poolAvailable) || 0), Number(affiliateAvailable) || 0)));
    return { payableAmount, payableCode: payableAmount > 0 ? null : 'PREPAID_NOT_WITHDRAWABLE' };
  }
  const pool = Math.max(0, Number(poolAvailable) || 0);
  const payableAmount = roundMoney(Math.max(0, Math.min(pool, Number(earnedAvailable) || 0)));
  const hasBalance = pool > 0 || Number(walletBalance) > 0;
  return { payableAmount, payableCode: payableAmount > 0 ? null : hasBalance ? 'PREPAID_NOT_WITHDRAWABLE' : null };
}

async function loadSellerEarnedAvailable(userId, now = new Date()) {
  const Order = require('../models/Order');
  const UsageEvent = require('../models/UsageEvent');
  const WalletTx = require('../models/WalletTx');
  const [orders, usage, walletTxs] = await Promise.all([
    Order.find({ seller: userId, status: { $in: ['paid', 'refunded', 'completed'] } })
      .select('sellerNetAmount sellerNet platformFee amount ownershipType status disputeStatus payoutHoldUntil completedAt createdAt')
      .lean(),
    UsageEvent.find({ seller: userId, sellerNet: { $gt: 0 } }).select('sellerNet createdAt').lean(),
    WalletTx.find({ user: userId, type: { $in: ['withdraw', 'debit', 'credit'] } })
      .select('type amount status note meta.persona reviewedBy')
      .lean(),
  ]);
  return sellerEarnedAvailable({ orders, usage, walletTxs, now });
}

module.exports = {
  PREPAID_MESSAGE,
  BUYER_MESSAGE,
  sellerEarnedAvailable,
  payoutCap,
  summaryPayable,
  loadSellerEarnedAvailable,
};
