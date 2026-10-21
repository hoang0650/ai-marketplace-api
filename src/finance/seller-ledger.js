const { roundMoney, effectiveSellerNet, isPayoutHeld, holdUntil, HOLD_MS } = require('../utils/payout-hold');

/**
 * Seller ledger (Sổ cái người bán), read-only. Every figure comes from what was stored when the
 * money moved, never from today's rates:
 *  - orders: the settlement snapshot on the Order (commission, tax, affiliate, store fee, seller net)
 *  - API/metered usage: UsageEvent (cost charged to the buyer, platformFee, sellerNet)
 *  - refunds / chargebacks / withdrawals / adjustments: the seller's WalletTx rows
 * Each sale is split into entries (revenue +gross, fee -x, tax -x, affiliate -x) that sum to the
 * seller net actually credited, so the running balance tracks the seller's wallet earnings.
 */
const TYPES = ['order_revenue', 'usage_revenue', 'platform_fee', 'tax_withheld', 'affiliate_commission', 'refund', 'withdrawal', 'adjustment'];

const r6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

function rateOf(amount, base) {
  return base > 0 ? Math.round((amount / base) * 10000) / 10000 : 0;
}

function orderStatus(order, now) {
  if (order.status === 'refunded') return 'refunded';
  return isPayoutHeld(order, now) ? 'holding' : 'available';
}

function orderEntries(order, now) {
  const snap = (order.financialSnapshot && typeof order.financialSnapshot === 'object' && order.financialSnapshot) || {};
  const gross = roundMoney(num(order.grossAmount) || num(snap.grossAmount) || num(order.amount));
  if (!(gross > 0) || (order.ownershipType || 'THIRD_PARTY_SELLER') === 'PLATFORM_DIRECT') return [];
  const fee = roundMoney(num(order.commissionAmount) || num(snap.commissionAmount));
  const storeFee = roundMoney(num(order.storeFeeAmount) || num(snap.storeFeeAmount));
  const payFee = roundMoney(num(order.paymentFeeAmount) || num(snap.paymentFeeAmount));
  const tax = roundMoney(num(order.taxAmount) || num(snap.taxAmount));
  const aff = roundMoney(num(order.affiliateCommissionAmount) || num(snap.affiliateCommissionAmount));
  const net = effectiveSellerNet(order);
  const at = order.completedAt || order.createdAt;
  const status = orderStatus(order, now);
  const commissionRate = order.commissionRate ?? snap.commissionRate ?? rateOf(fee, gross);
  const taxRate = order.taxPolicy?.rate ?? snap.taxPolicy?.rate ?? rateOf(tax, gross);
  const base = {
    date: new Date(at).toISOString(),
    orderId: String(order._id),
    orderRef: String(order._id).slice(-8).toUpperCase(),
    product: order.productName || order.contractSnapshot?.productName || '',
    currency: order.currency || 'USD',
    status,
    holdUntil: holdUntil(order).toISOString(),
    sellerType: order.taxPolicy?.sellerType || snap.sellerType || snap.taxPolicy?.sellerType || '',
  };
  const rows = [
    { ...base, type: 'order_revenue', gross, fee: 0, tax: 0, net: gross, rate: null },
  ];
  if (fee + storeFee + payFee > 0) {
    rows.push({ ...base, type: 'platform_fee', gross: 0, fee: roundMoney(fee + storeFee + payFee), tax: 0, net: -roundMoney(fee + storeFee + payFee), rate: commissionRate });
  }
  if (tax > 0) rows.push({ ...base, type: 'tax_withheld', gross: 0, fee: 0, tax, net: -tax, rate: taxRate });
  if (aff > 0) {
    rows.push({ ...base, type: 'affiliate_commission', gross: 0, fee: aff, tax: 0, net: -aff, rate: order.affiliateRate ?? snap.affiliateRate ?? rateOf(aff, gross) });
  }
  // Rounding / legacy orders: keep the entries summing to the net that was actually credited.
  const sum = roundMoney(rows.reduce((s, x) => s + x.net, 0));
  const diff = roundMoney(net - sum);
  if (Math.abs(diff) >= 0.01) rows.push({ ...base, type: 'adjustment', gross: 0, fee: 0, tax: 0, net: diff, rate: null, note: 'settlement rounding / legacy snapshot' });
  return rows;
}

/** Usage revenue grouped per product per day (one row per call would be unreadable). */
function usageEntries(events, now) {
  const groups = new Map();
  for (const e of events) {
    const k = `${dayKey(e.createdAt)}|${e.product}|${e.currency || 'USD'}`;
    const g = groups.get(k) || { date: e.createdAt, product: e.productName || '', productId: String(e.product), currency: e.currency || 'USD', cost: 0, fee: 0, net: 0, last: e.createdAt, n: 0 };
    g.cost += num(e.cost);
    g.fee += num(e.platformFee);
    g.net += num(e.sellerNet);
    g.n += 1;
    if (new Date(e.createdAt) > new Date(g.last)) g.last = e.createdAt;
    if (new Date(e.createdAt) < new Date(g.date)) g.date = e.createdAt;
    groups.set(k, g);
  }
  const rows = [];
  for (const g of groups.values()) {
    const gross = roundMoney(g.cost);
    const fee = roundMoney(g.fee);
    const net = roundMoney(g.net);
    const tax = roundMoney(Math.max(0, gross - fee - net));
    const held = now.getTime() < new Date(g.last).getTime() + HOLD_MS;
    const base = { date: new Date(g.date).toISOString(), orderId: '', orderRef: `USAGE ${dayKey(g.date)}`, product: g.product, currency: g.currency, status: held ? 'holding' : 'available', holdUntil: new Date(new Date(g.last).getTime() + HOLD_MS).toISOString(), calls: g.n };
    rows.push({ ...base, type: 'usage_revenue', gross, fee: 0, tax: 0, net: gross, rate: null });
    if (fee > 0) rows.push({ ...base, type: 'platform_fee', gross: 0, fee, tax: 0, net: -fee, rate: rateOf(fee, gross) });
    if (tax > 0) rows.push({ ...base, type: 'tax_withheld', gross: 0, fee: 0, tax, net: -tax, rate: rateOf(tax, gross) });
  }
  return rows;
}

const SALE_CREDIT = /^Seller payable:|\(seller payable after commission\/tax\)$/;
const REFUND_NOTE = /^(Refund clawback|Chargeback)\b/;
const ORDER_IN_NOTE = /order ([a-f0-9]{24})/i;

/** Wallet rows that belong to the seller ledger (sale credits are already covered by orders/usage). */
function walletEntries(txs) {
  const rows = [];
  for (const t of txs) {
    const note = t.note || '';
    const amount = roundMoney(t.amount);
    const base = { date: new Date(t.createdAt).toISOString(), currency: t.currency || 'USD', note, txId: String(t._id || t.id || '') };
    const oid = (note.match(ORDER_IN_NOTE) || [])[1] || '';
    if (t.type === 'withdraw') {
      const st = t.status === 'completed' ? 'paid' : t.status === 'pending' ? 'processing' : t.status;
      rows.push({ ...base, type: 'withdrawal', orderId: '', orderRef: t.payoutId || '', gross: 0, fee: 0, tax: 0, net: -amount, rate: null, status: st, counts: ['completed', 'pending'].includes(t.status) });
    } else if (t.type === 'debit' && REFUND_NOTE.test(note)) {
      rows.push({ ...base, type: 'refund', orderId: oid, orderRef: oid ? oid.slice(-8).toUpperCase() : '', gross: 0, fee: 0, tax: 0, net: -amount, rate: null, status: 'settled', counts: t.status !== 'failed' && t.status !== 'cancelled' });
    } else if ((t.type === 'credit' || t.type === 'debit') && t.reviewedBy && !SALE_CREDIT.test(note)) {
      // Manual admin adjustment on the seller's wallet.
      rows.push({ ...base, type: 'adjustment', orderId: oid, orderRef: '', gross: 0, fee: 0, tax: 0, net: t.type === 'credit' ? amount : -amount, rate: null, status: 'settled', counts: t.status !== 'failed' && t.status !== 'cancelled' });
    }
  }
  return rows;
}

function buildSellerLedger({ orders = [], usage = [], txs = [], now = new Date(), balance = null }) {
  const rows = [...orders.flatMap((o) => orderEntries(o, now)), ...usageEntries(usage, now), ...walletEntries(txs)]
    .map((r) => ({ counts: true, ...r }))
    .sort((a, b) => new Date(a.date) - new Date(b.date) || TYPES.indexOf(a.type) - TYPES.indexOf(b.type));
  let run = 0;
  for (const r of rows) {
    if (r.counts) run = r6(run + r.net);
    r.balance = roundMoney(run);
  }
  const sum = (pred, f) => roundMoney(rows.filter(pred).reduce((s, r) => s + f(r), 0));
  const isRev = (r) => r.type === 'order_revenue' || r.type === 'usage_revenue';
  const earned = (r) => isRev(r) || ['platform_fee', 'tax_withheld', 'affiliate_commission'].includes(r.type) || (r.type === 'adjustment' && r.orderId);
  const summary = {
    currency: 'USD',
    grossRevenue: sum(isRev, (r) => r.gross),
    platformFees: sum((r) => r.type === 'platform_fee', (r) => r.fee),
    taxWithheld: sum((r) => r.type === 'tax_withheld', (r) => r.tax),
    affiliatePaid: sum((r) => r.type === 'affiliate_commission', (r) => r.fee),
    refunds: sum((r) => r.type === 'refund' && r.counts, (r) => -r.net),
    adjustments: sum((r) => r.type === 'adjustment' && !r.orderId && r.counts, (r) => r.net),
    netEarnings: 0,
    onHold: sum((r) => r.status === 'holding' && earned(r), (r) => r.net),
    withdrawn: sum((r) => r.type === 'withdrawal' && r.status === 'paid', (r) => -r.net),
    withdrawPending: sum((r) => r.type === 'withdrawal' && r.status === 'processing', (r) => -r.net),
    ledgerBalance: roundMoney(run),
    available: null,
    walletBalance: null,
  };
  summary.netEarnings = roundMoney(sum(earned, (r) => r.net) - summary.refunds + summary.adjustments);
  if (balance) {
    summary.available = balance.available;
    summary.walletBalance = balance.balance;
    summary.walletHeld = balance.held;
  } else {
    summary.available = roundMoney(Math.max(0, summary.ledgerBalance - summary.onHold));
  }
  return { entries: rows.reverse(), summary, types: TYPES };
}

function filterEntries(entries, { from, to, type } = {}) {
  const f = from ? new Date(from) : null;
  const t = to ? new Date(`${String(to).slice(0, 10)}T23:59:59.999Z`) : null;
  const types = type ? String(type).split(',').filter((x) => TYPES.includes(x)) : null;
  return entries.filter((e) => {
    const d = new Date(e.date);
    if (f && !Number.isNaN(f.getTime()) && d < f) return false;
    if (t && !Number.isNaN(t.getTime()) && d > t) return false;
    if (types && types.length && !types.includes(e.type)) return false;
    return true;
  });
}

module.exports = { TYPES, buildSellerLedger, filterEntries, orderEntries, usageEntries, walletEntries };
