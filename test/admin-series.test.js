const test = require('node:test');
const assert = require('node:assert/strict');
const Order = require('../src/models/Order');
const WalletTx = require('../src/models/WalletTx');
const User = require('../src/models/User');
const { adminDailySeries, adminSeries, fillDays, dayKey, weekStart } = require('../src/utils/admin-series');

const now = new Date('2026-10-04T09:00:00Z');

test('dayKey uses Vietnam time', () => {
  assert.equal(dayKey(new Date('2026-10-03T18:30:00Z')), '2026-10-04');
});

test('fillDays returns one zeroed row per day, oldest first', () => {
  const rows = fillDays(3, now, []);
  assert.deepEqual(rows.map((r) => r.date), ['2026-10-02', '2026-10-03', '2026-10-04']);
  assert.ok(rows.every((r) => r.gross === 0 && r.orders === 0 && r.users === 0));
});

test('adminDailySeries merges orders, deposits and sign-ups by day', async (t) => {
  t.mock.method(Order, 'aggregate', async () => [{ _id: '2026-10-04', gross: 20, platformFee: 4, sellerNet: 14.4, orders: 2 }]);
  t.mock.method(WalletTx, 'aggregate', async () => [{ _id: '2026-10-03', deposits: 50 }, { _id: '2025-01-01', deposits: 999 }]);
  t.mock.method(User, 'aggregate', async () => [{ _id: '2026-10-04', users: 3 }]);
  const rows = await adminDailySeries({ days: 7, now });
  assert.equal(rows.length, 7);
  const today = rows.at(-1);
  assert.deepEqual(today, { date: '2026-10-04', gross: 20, platformFee: 4, sellerNet: 14.4, orders: 2, deposits: 0, users: 3 });
  assert.equal(rows.at(-2).deposits, 50);
  assert.equal(rows.reduce((s, r) => s + r.deposits, 0), 50);
});

test('weekStart returns the Monday of the week', () => {
  assert.equal(weekStart('2026-10-04'), '2026-09-28');
  assert.equal(weekStart('2026-09-28'), '2026-09-28');
});

function mockSources(t) {
  t.mock.method(Order, 'aggregate', async () => [
    { _id: '2026-09-27', gross: 5, platformFee: 1, sellerNet: 3.6, orders: 1 },
    { _id: '2026-09-29', gross: 10, platformFee: 2, sellerNet: 7.2, orders: 1 },
    { _id: '2026-10-04', gross: 20, platformFee: 4, sellerNet: 14.4, orders: 2 },
  ]);
  t.mock.method(WalletTx, 'aggregate', async () => []);
  t.mock.method(User, 'aggregate', async () => []);
}

test('weekly series has 12 Monday-start buckets and sums days into them', async (t) => {
  mockSources(t);
  const { granularity, series } = await adminSeries({ granularity: 'week', now });
  assert.equal(granularity, 'week');
  assert.equal(series.length, 12);
  assert.equal(series[0].date, '2026-07-13');
  assert.deepEqual(series.at(-1), { date: '2026-09-28', gross: 30, platformFee: 6, sellerNet: 21.6, orders: 3, deposits: 0, users: 0 });
  assert.equal(series.at(-2).gross, 5);
});

test('monthly series covers the last 12 calendar months', async (t) => {
  mockSources(t);
  const { series } = await adminSeries({ granularity: 'month', now });
  assert.equal(series.length, 12);
  assert.equal(series[0].date, '2025-11-01');
  assert.equal(series.at(-1).date, '2026-10-01');
  assert.equal(series.at(-1).gross, 20);
  assert.equal(series.at(-2).gross, 15);
});

test('unknown granularity falls back to 30 days', async (t) => {
  mockSources(t);
  const { granularity, series } = await adminSeries({ granularity: 'year', now });
  assert.equal(granularity, 'day');
  assert.equal(series.length, 30);
});
