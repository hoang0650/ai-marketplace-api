const GameSession = require('../models/GameSession');
const GpuServer = require('../models/GpuServer');
const Product = require('../models/Product');
const UsageEvent = require('../models/UsageEvent');
const UsageStat = require('../models/UsageStat');
const { getAvailableBalance, sweepStaleHolds } = require('./wallet');
const { chargeUsage } = require('../finance/charge-usage');
const { notifyUser } = require('./notify');
const { callSellerWebhook, usageRatePerHour } = require('./compute-session');
const { GAME_IDLE_MS } = require('../terminal/permission.service');

const LIVE = ['starting', 'live'];
const HEARTBEAT_MS = 30_000;

function gameBillingConfig() {
  return {
    tickMs: Number(process.env.GAME_BILLING_TICK_MS || 60_000),
    /** Clients that heartbeat are stopped after this much silence. */
    idleMs: GAME_IDLE_MS,
    /** Older clients never heartbeat: cap their sessions instead of billing forever. */
    noHeartbeatMaxMs: Number(process.env.GAME_NO_HEARTBEAT_MAX_MS || 4 * 3_600_000),
    warnMinutes: Number(process.env.GAME_LOW_BALANCE_MINUTES || 5),
  };
}

function plain(product) {
  return product && typeof product.toObject === 'function' ? product.toObject() : product;
}

/** USD/hour the buyer pays for this session (0 when free or the seller plays their own listing). */
function sessionRate(session, product) {
  if (!product) return 0;
  if (String(session.user) === String(product.creator)) return 0;
  return usageRatePerHour(product);
}

function cursorOf(session) {
  return new Date(session.billedUntil || session.billingStartedAt || session.createdAt || Date.now());
}

/** Cents, rounded down (ticks) or up (final settle) after snapping float noise to 1e-6. */
function toCents(amount, up = false) {
  const micro = Math.round(amount * 1e6) / 1e4;
  return (up ? Math.ceil(micro - 1e-9) : Math.floor(micro + 1e-9)) / 100;
}

/**
 * Whole minutes since the cursor at `ratePerHour`, charged in cents with the sub-cent
 * remainder carried. `final` rounds the last partial minute up (minimum 1 minute per session)
 * and rounds the remaining sub-cent carry up so nothing is left unbilled at stop.
 */
function accrue({ from, carry = 0 }, ratePerHour, now = new Date(), { final = false } = {}) {
  const start = new Date(from);
  const ms = now.getTime() - start.getTime();
  const prevCarry = Number(carry) || 0;
  let minutes = ms > 0 ? Math.floor(ms / 60_000) : 0;
  if (final && ms > 0 && ms % 60_000 > 0) minutes += 1;
  if (minutes < 1) {
    if (final && prevCarry > 0) return { minutes: 0, charge: toCents(prevCarry, true), carry: 0, to: start };
    return { minutes: 0, charge: 0, carry, to: start };
  }
  const accrued = (minutes * Math.max(0, ratePerHour)) / 60 + prevCarry;
  const charge = toCents(accrued, final);
  return {
    minutes,
    charge,
    carry: final ? 0 : Math.max(0, Math.round((accrued - charge) * 1e6) / 1e6),
    to: new Date(start.getTime() + minutes * 60_000),
  };
}

async function recordCharge(session, product, a, rate) {
  const buyerId = session.user;
  const sellerId = product.creator;
  const device = session.device || 'pc';
  const billed = await chargeUsage({
    buyerId,
    sellerId,
    product,
    cost: a.charge,
    // Time already elapsed: bill what the wallet covers, never below zero (enforceSession stops it).
    funds: 'cap',
    note: `Stream: ${product.name} (${a.minutes}m · ${device})`,
  });
  if (billed.skipped) return billed;
  await UsageEvent.create({
    product: product._id,
    buyer: buyerId,
    seller: sellerId,
    inputTokens: 0,
    outputTokens: 0,
    cost: billed.charged,
    platformFee: billed.platformFee,
    sellerNet: billed.sellerNet,
    unit: product.pricing?.usageUnit || 'hours',
    quantity: a.minutes / 60,
    rawUsage: {
      minutes: a.minutes,
      ratePerHour: rate,
      ...(billed.shortfall ? { shortfall: billed.shortfall } : {}),
      sessionId: session.sessionId,
      client: session.client || 'pc',
      device,
      hosting: session.hosting || '',
    },
    source: 'gpu',
    usageType: product.category === 'game-server' ? 'GAME_RUNTIME' : 'GPU_HOUR',
  });
  const day = new Date().toISOString().slice(0, 10);
  await UsageStat.updateOne(
    { creator: sellerId, date: day },
    { $inc: { gpuHours: a.minutes / 60, requests: 1, revenue: billed.sellerNet } },
    { upsert: true }
  ).catch(() => {});
  return billed;
}

/**
 * Charge everything up to `now`. The cursor moves with compare-and-set, so concurrent
 * ticks / replicas / a parallel stop can never bill the same minute twice.
 */
async function settleSession(session, product, now = new Date(), opts = {}) {
  const rate = sessionRate(session, product);
  // The final settle must not lose the tail when a concurrent tick moved the cursor first:
  // reload and re-accrue from the new cursor instead of giving up.
  const attempts = opts.final ? 4 : 1;
  for (let i = 0; i < attempts; i += 1) {
    const prev = session.billedUntil || null;
    const a = accrue({ from: cursorOf(session), carry: session.billingCarry }, rate, now, opts);
    if (!a.minutes && !a.charge) return 0;
    const moved = await GameSession.findOneAndUpdate(
      { _id: session._id, billedUntil: prev },
      {
        $set: { billedUntil: a.to, billingCarry: a.carry },
        $inc: { billedMinutes: a.minutes, billedCost: a.charge },
      },
      { new: true }
    );
    if (moved) {
      session.billedUntil = moved.billedUntil;
      session.billingCarry = moved.billingCarry;
      session.billedMinutes = moved.billedMinutes;
      session.billedCost = moved.billedCost;
      if (a.charge > 0) await recordCharge(session, plain(product), a, rate);
      return a.charge;
    }
    if (i + 1 >= attempts) return 0;
    const fresh = await GameSession.findById(session._id).lean();
    if (!fresh) return 0;
    session.billedUntil = fresh.billedUntil;
    session.billingCarry = fresh.billingCarry;
    session.billedMinutes = fresh.billedMinutes;
    session.billedCost = fresh.billedCost;
  }
  return 0;
}

/** Stop once (atomic claim), bill the tail, tell the seller node. */
async function stopGameSession(doc, reason = 'user', { product: loaded } = {}) {
  if (!doc || doc.status === 'stopped') return doc;
  const now = new Date();
  const claimed = await GameSession.findOneAndUpdate(
    { _id: doc._id, status: { $in: LIVE } },
    { $set: { status: 'stopped', stoppedAt: now, stopReason: reason } },
    { new: true }
  );
  if (!claimed) {
    doc.status = 'stopped';
    return doc;
  }
  Object.assign(doc, { status: 'stopped', stoppedAt: now, stopReason: reason });
  const product = loaded || (doc.product ? await Product.findById(doc.product).lean() : null);
  if (product) {
    try {
      await settleSession(doc, product, now, { final: true });
    } catch (err) {
      console.error('[game-billing] final settle failed', doc.sessionId, err.code || err.message);
    }
  }
  const server = await GpuServer.findById(doc.server);
  if (server?.webhookUrl) {
    callSellerWebhook(server, 'session.stop', {
      sessionId: doc.sessionId,
      buyerId: String(doc.user),
      client: doc.client || 'pc',
      device: doc.device || 'pc',
      reason,
      minutes: doc.billedMinutes,
      billedCost: doc.billedCost,
    }).catch(() => {});
  }
  return doc;
}

/** Idle / low-balance policy for a live session. Returns 'ok' | 'warned' | 'idle' | 'stopped'. */
async function enforceSession(session, product, now = new Date()) {
  const cfg = gameBillingConfig();
  const last = new Date(session.lastActivityAt || session.createdAt || now).getTime();
  const silentMs = now.getTime() - last;
  if ((session.heartbeatAt && silentMs > cfg.idleMs) || (!session.heartbeatAt && silentMs > cfg.noHeartbeatMaxMs)) {
    await stopGameSession(session, 'idle', { product });
    return 'idle';
  }

  const rate = sessionRate(session, product);
  if (rate <= 0) return 'ok';
  const perMinute = rate / 60;
  const { available } = await getAvailableBalance(session.user);
  const href = product?.slug ? `/play/${product.slug}` : '/wallet';
  if (available < perMinute) {
    await stopGameSession(session, 'insufficient_funds', { product });
    await notifyUser(session.user, 'stream.stoppedNoFunds', { name: product?.name || '' }, '/wallet').catch(() => {});
    return 'stopped';
  }
  if (available < perMinute * cfg.warnMinutes) {
    if (!session.lowBalanceWarnedAt) {
      session.lowBalanceWarnedAt = now;
      await GameSession.updateOne({ _id: session._id }, { $set: { lowBalanceWarnedAt: now } });
      await notifyUser(
        session.user,
        'stream.lowBalance',
        { name: product?.name || '', minutes: Math.max(1, Math.floor(available / perMinute)) },
        href
      ).catch(() => {});
      return 'warned';
    }
  } else if (session.lowBalanceWarnedAt && available >= perMinute * cfg.warnMinutes * 2) {
    session.lowBalanceWarnedAt = null;
    await GameSession.updateOne({ _id: session._id }, { $set: { lowBalanceWarnedAt: null } });
  }
  return 'ok';
}

async function tickSession(session, product, now = new Date()) {
  if (product) await settleSession(session, product, now);
  return enforceSession(session, product, now);
}

async function runGameBillingTick(now = new Date()) {
  // Piggy-back: free spend reservations orphaned by a crashed playground/gateway request.
  await sweepStaleHolds(null, now).catch(() => {});
  const rows = await GameSession.find({ status: { $in: LIVE } });
  const ids = [...new Set(rows.map((r) => String(r.product || '')).filter(Boolean))];
  const products = ids.length ? await Product.find({ _id: { $in: ids } }).lean() : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const out = { total: rows.length, idle: 0, stopped: 0, errors: 0 };
  for (const session of rows) {
    try {
      const r = await tickSession(session, byId.get(String(session.product || '')) || null, now);
      if (r === 'idle') out.idle += 1;
      if (r === 'stopped') out.stopped += 1;
    } catch (err) {
      out.errors += 1;
      console.error('[game-billing] tick failed', session.sessionId, err.code || err.message);
    }
  }
  return out;
}

/** Live billing snapshot for heartbeat responses. */
async function sessionBillingState(session, product) {
  const rate = sessionRate(session, product);
  const state = {
    ratePerHour: rate,
    billedMinutes: session.billedMinutes || 0,
    billedCost: Math.round((session.billedCost || 0) * 100) / 100,
    currency: product?.pricing?.currency || 'USD',
  };
  if (rate > 0) {
    const { available } = await getAvailableBalance(session.user);
    state.available = available;
    state.minutesLeft = Math.max(0, Math.floor(available / (rate / 60)));
  }
  return state;
}

let timer = null;
let busy = false;

function startGameBillingWorker() {
  if (timer) return timer;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await runGameBillingTick();
      if (r.idle || r.stopped || r.errors) console.log('[game-billing] tick', JSON.stringify(r));
    } catch (err) {
      console.error('[game-billing] tick error', err.message);
    } finally {
      busy = false;
    }
  }, gameBillingConfig().tickMs);
  timer.unref?.();
  return timer;
}

function stopGameBillingWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  LIVE,
  HEARTBEAT_MS,
  gameBillingConfig,
  sessionRate,
  accrue,
  settleSession,
  stopGameSession,
  enforceSession,
  tickSession,
  runGameBillingTick,
  sessionBillingState,
  startGameBillingWorker,
  stopGameBillingWorker,
};
