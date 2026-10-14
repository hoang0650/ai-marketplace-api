const test = require('node:test');
const assert = require('node:assert');
const { buildSellerLedger, filterEntries } = require('../src/finance/seller-ledger');

const now = new Date('2026-10-14T12:00:00Z');
const oid = (n) => n.toString(16).padStart(24, '0');
const orders = [
  // Individual seller, 1,000,000-style example scaled to USD: 100 gross, 20% fee, 7% tax, 25% affiliate → 48 net.
  { _id: oid(1), amount: 100, grossAmount: 100, commissionRate: 0.2, commissionAmount: 20, taxAmount: 7, taxPolicy: { rate: 0.07, sellerType: 'INDIVIDUAL' }, affiliateRate: 0.25, affiliateCommissionAmount: 25, sellerNetAmount: 48, status: 'paid', completedAt: new Date('2026-10-01T00:00:00Z'), payoutHoldUntil: new Date('2026-10-03T00:00:00Z'), productName: 'Agent A' },
  // Company seller, held (within 48h): 0% tax.
  { _id: oid(2), amount: 50, grossAmount: 50, commissionRate: 0.2, commissionAmount: 10, taxAmount: 0, taxPolicy: { rate: 0, sellerType: 'COMPANY' }, sellerNetAmount: 40, status: 'paid', completedAt: new Date('2026-10-14T00:00:00Z'), payoutHoldUntil: new Date('2026-10-16T00:00:00Z'), productName: 'API B' },
  { _id: oid(3), amount: 10, ownershipType: 'PLATFORM_DIRECT', status: 'paid', completedAt: now },
];
const txs = [
  { _id: 'w1', type: 'withdraw', amount: 30, status: 'completed', createdAt: new Date('2026-10-05T00:00:00Z'), payoutId: 'PO1' },
  { _id: 'w2', type: 'withdraw', amount: 5, status: 'failed', createdAt: new Date('2026-10-06T00:00:00Z') },
  { _id: 'c1', type: 'debit', amount: 4.8, note: `Refund clawback ref_x order ${oid(1)}`, createdAt: new Date('2026-10-02T00:00:00Z') },
  { _id: 's1', type: 'credit', amount: 48, note: 'Seller payable: Agent A (commission 20 snapshot, tax 7, affiliate 25)', createdAt: new Date('2026-10-01T00:00:00Z') },
  { _id: 'b1', type: 'debit', amount: 9, note: 'Order xyz', createdAt: new Date('2026-10-01T00:00:00Z') },
];
const usage = [
  { product: 'p9', productName: 'API B', cost: 1, platformFee: 0.2, sellerNet: 0.73, currency: 'USD', createdAt: new Date('2026-10-10T01:00:00Z') },
  { product: 'p9', productName: 'API B', cost: 1, platformFee: 0.2, sellerNet: 0.73, currency: 'USD', createdAt: new Date('2026-10-10T05:00:00Z') },
];

test('splits orders into revenue/fee/tax/affiliate entries from the snapshot', () => {
  const { entries } = buildSellerLedger({ orders, txs, usage, now });
  const o1 = entries.filter((e) => e.orderId === oid(1) && e.type !== 'refund');
  assert.deepStrictEqual(o1.map((e) => e.type).sort(), ['affiliate_commission', 'order_revenue', 'platform_fee', 'tax_withheld']);
  assert.strictEqual(o1.reduce((s, e) => s + e.net, 0), 48);
  assert.strictEqual(o1.find((e) => e.type === 'platform_fee').rate, 0.2);
  assert.strictEqual(o1.find((e) => e.type === 'tax_withheld').rate, 0.07);
  assert.strictEqual(o1.find((e) => e.type === 'affiliate_commission').rate, 0.25);
  assert.ok(o1.every((e) => e.status === 'available'));
  assert.ok(entries.filter((e) => e.orderId === oid(2)).every((e) => e.status === 'holding'));
  assert.ok(!entries.some((e) => e.orderId === oid(3)), 'platform-direct sales are not seller revenue');
  assert.ok(!entries.some((e) => e.txId === 's1' || e.txId === 'b1'), 'sale credits and buyer debits are not duplicated');
});

test('summary and running balance', () => {
  const { entries, summary } = buildSellerLedger({ orders, txs, usage, now });
  assert.strictEqual(summary.grossRevenue, 152);
  assert.strictEqual(summary.platformFees, 30.4);
  assert.strictEqual(summary.taxWithheld, 7.14);
  assert.strictEqual(summary.affiliatePaid, 25);
  assert.strictEqual(summary.refunds, 4.8);
  assert.strictEqual(summary.withdrawn, 30);
  assert.strictEqual(summary.onHold, 40);
  assert.strictEqual(summary.netEarnings, 48 + 40 + 1.46 - 4.8);
  // Failed withdrawal does not move the balance; newest entry carries the final balance.
  assert.strictEqual(entries[0].balance, summary.ledgerBalance);
  assert.strictEqual(summary.ledgerBalance, Math.round((48 + 40 + 1.46 - 4.8 - 30) * 100) / 100);
  const failed = entries.find((e) => e.txId === 'w2');
  assert.strictEqual(failed.counts, false);
  assert.strictEqual(entries.find((e) => e.txId === 'w1').status, 'paid');
});

test('usage is grouped per product per day with tax derived from the stored split', () => {
  const { entries } = buildSellerLedger({ usage, now });
  const rev = entries.find((e) => e.type === 'usage_revenue');
  assert.strictEqual(rev.gross, 2);
  assert.strictEqual(rev.calls, 2);
  assert.strictEqual(entries.find((e) => e.type === 'tax_withheld').tax, 0.14);
});

test('filters by date range and type', () => {
  const { entries } = buildSellerLedger({ orders, txs, usage, now });
  assert.ok(filterEntries(entries, { type: 'withdrawal' }).every((e) => e.type === 'withdrawal'));
  const oct14 = filterEntries(entries, { from: '2026-10-14', to: '2026-10-14' });
  assert.ok(oct14.length > 0 && oct14.every((e) => e.date.startsWith('2026-10-14')));
});
