const Order = require('../models/Order');
const WalletTx = require('../models/WalletTx');
const User = require('../models/User');

const TZ = 'Asia/Ho_Chi_Minh';
const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD in Vietnam time. */
function dayKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Every day in the window (oldest first) with zeroed metrics, merged with aggregate rows keyed by `_id`. */
function fillDays(days, now, sources) {
  const out = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const row = { date: dayKey(new Date(now.getTime() - i * DAY_MS)), gross: 0, platformFee: 0, sellerNet: 0, orders: 0, deposits: 0, users: 0 };
    if (!index.has(row.date)) {
      index.set(row.date, row);
      out.push(row);
    }
  }
  for (const rows of sources) {
    for (const r of rows) {
      const target = index.get(r._id);
      if (!target) continue;
      for (const [k, v] of Object.entries(r)) {
        if (k !== '_id') target[k] += Number(v) || 0;
      }
    }
  }
  return out;
}

const byDay = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ } });

/** Daily GMV / platform fee / seller net / paid orders / deposits / sign-ups for the admin overview charts. */
async function adminDailySeries({ days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * DAY_MS);
  const [orders, deposits, users] = await Promise.all([
    Order.aggregate([
      { $match: { status: 'paid', createdAt: { $gte: since } } },
      {
        $group: {
          _id: byDay('$createdAt'),
          gross: { $sum: '$amount' },
          platformFee: { $sum: { $ifNull: ['$platformRevenueAmount', { $ifNull: ['$platformFee', 0] }] } },
          sellerNet: { $sum: { $ifNull: ['$sellerNetAmount', { $ifNull: ['$sellerNet', 0] }] } },
          orders: { $sum: 1 },
        },
      },
    ]),
    WalletTx.aggregate([
      { $match: { type: 'deposit', status: { $nin: ['pending', 'failed', 'cancelled'] }, createdAt: { $gte: since } } },
      { $group: { _id: byDay('$createdAt'), deposits: { $sum: '$amount' } } },
    ]),
    User.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: byDay('$createdAt'), users: { $sum: 1 } } },
    ]),
  ]);
  return fillDays(days, now, [orders, deposits, users]);
}

/** Buckets shown per granularity (30 days, 12 weeks, 12 months). */
const PERIODS = { day: 30, week: 12, month: 12 };
const METRICS = ['gross', 'platformFee', 'sellerNet', 'orders', 'deposits', 'users'];

function addDays(key, n) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `key` (YYYY-MM-DD). */
function weekStart(key) {
  return addDays(key, -((new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7));
}

function monthStart(key) {
  return `${key.slice(0, 7)}-01`;
}

/** Sum daily rows into buckets keyed by their first day. */
function rollup(daily, bucketOf) {
  const out = [];
  const index = new Map();
  for (const row of daily) {
    const key = bucketOf(row.date);
    const bucket = index.get(key);
    if (!bucket) {
      const fresh = { ...row, date: key };
      index.set(key, fresh);
      out.push(fresh);
    } else {
      for (const k of METRICS) bucket[k] += row[k];
    }
  }
  return out;
}

/**
 * Revenue / activity series by day (30), week (12, Monday start) or month (12), Vietnam time.
 * Weeks and months are rolled up from daily buckets so no `$dateTrunc` (MongoDB 5+) is needed.
 */
async function adminSeries({ granularity = 'day', now = new Date() } = {}) {
  const g = PERIODS[granularity] ? granularity : 'day';
  if (g === 'day') return { granularity: g, series: await adminDailySeries({ days: PERIODS.day, now }) };
  const today = dayKey(now);
  let start;
  if (g === 'week') {
    start = addDays(weekStart(today), -7 * (PERIODS.week - 1));
  } else {
    const [y, m] = today.split('-').map(Number);
    start = new Date(Date.UTC(y, m - 1 - (PERIODS.month - 1), 1)).toISOString().slice(0, 10);
  }
  const days = Math.round((Date.parse(today) - Date.parse(start)) / DAY_MS) + 1;
  const daily = await adminDailySeries({ days, now });
  return { granularity: g, series: rollup(daily, g === 'week' ? weekStart : monthStart) };
}

module.exports = { adminDailySeries, adminSeries, fillDays, dayKey, weekStart };
