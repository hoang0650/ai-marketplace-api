/**
 * Community agent vote cycles (Asia/Bangkok calendar). VOTE_CYCLE = monthly (default) | weekly.
 * A cycle key is 'YYYY-MM' (monthly) or 'YYYY-Www' (ISO week, weekly).
 */
const TZ_OFFSET_MS = 7 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

function cyclePeriod(env = process.env) {
  const p = String(env.VOTE_CYCLE || 'monthly').trim().toLowerCase();
  return p === 'weekly' ? 'weekly' : 'monthly';
}

const pad = (n) => String(n).padStart(2, '0');

/** Start (UTC Date) of the cycle containing `at`. */
function cycleStart(at, period) {
  const local = new Date(new Date(at).getTime() + TZ_OFFSET_MS);
  if (period === 'weekly') {
    const dow = (local.getUTCDay() + 6) % 7; // Monday = 0
    const d = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - dow * DAY;
    return new Date(d - TZ_OFFSET_MS);
  }
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - TZ_OFFSET_MS);
}

function cycleEnd(at, period) {
  const start = cycleStart(at, period);
  if (period === 'weekly') return new Date(start.getTime() + 7 * DAY);
  const local = new Date(start.getTime() + TZ_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - TZ_OFFSET_MS);
}

function cycleKey(at, period) {
  const start = new Date(cycleStart(at, period).getTime() + TZ_OFFSET_MS);
  if (period === 'weekly') {
    // ISO week number of the Monday `start` (Thursday rule).
    const th = new Date(start.getTime() + 3 * DAY);
    const jan1 = Date.UTC(th.getUTCFullYear(), 0, 1);
    const week = Math.floor((th.getTime() - jan1) / DAY / 7) + 1;
    return `${th.getUTCFullYear()}-W${pad(week)}`;
  }
  return `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}`;
}

function cycleInfo(at = new Date(), period = cyclePeriod()) {
  return { period, key: cycleKey(at, period), startsAt: cycleStart(at, period), endsAt: cycleEnd(at, period) };
}

/** Info of the cycle immediately before the one containing `at`. */
function previousCycle(at = new Date(), period = cyclePeriod()) {
  return cycleInfo(new Date(cycleStart(at, period).getTime() - 1), period);
}

module.exports = { cyclePeriod, cycleKey, cycleStart, cycleEnd, cycleInfo, previousCycle };
