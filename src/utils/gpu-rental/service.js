const crypto = require('crypto');
const GpuRental = require('../../models/GpuRental');
const WalletTx = require('../../models/WalletTx');
const { getAvailableBalance } = require('../wallet');
const { roundMoney } = require('../payout-hold');
const { notifyUser } = require('../notify');
const { gpuRentalConfig } = require('./config');
const { quote, toOffer } = require('./pricing');
const provider = require('./provider');

const ACTIVE = ['creating', 'running', 'stopped', 'error'];
const JUPYTER_PORT = 8888;

function httpError(status, code, extra = {}) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// ---------- offers ----------

let offersCache = { at: 0, rows: [] };

async function listOffers({ fresh = false } = {}) {
  const cfg = gpuRentalConfig();
  if (!fresh && offersCache.rows.length && Date.now() - offersCache.at < cfg.offersTtlMs) return offersCache.rows;
  const rows = await provider.listGpuTypes();
  offersCache = { at: Date.now(), rows };
  return rows;
}

async function publicOffers() {
  const cfg = gpuRentalConfig();
  const rows = await listOffers();
  return rows.map((r) => toOffer(r, cfg));
}

function resetOffersCache() {
  offersCache = { at: 0, rows: [] };
}

// ---------- serialization ----------

function jupyterBasePath(rentalId) {
  return `/v1/gpu/rentals/${rentalId}/jupyter/`;
}

function publicRental(doc) {
  const id = String(doc._id || doc.id);
  return {
    id,
    name: doc.name,
    gpu: { id: doc.offerId, name: doc.gpuName, memoryGb: doc.gpuMemoryGb, count: doc.gpuCount },
    diskGb: doc.diskGb,
    volumeGb: doc.volumeGb,
    status: doc.status,
    ready: doc.status === 'running' && Boolean(doc.ready),
    pricePerHour: doc.pricePerHour,
    stoppedPricePerHour: doc.stoppedPricePerHour,
    currency: 'USD',
    billedMinutes: doc.billedMinutes || 0,
    billedTotal: roundMoney(doc.billedTotal || 0),
    stoppedReason: doc.stoppedReason || '',
    terminateAfter: doc.terminateAfter || null,
    createdAt: doc.createdAt,
    stoppedAt: doc.stoppedAt || null,
    terminatedAt: doc.terminatedAt || null,
  };
}

// ---------- pod command ----------

/**
 * Container start command: scrub vendor env vars so a user shell never sees them, then run
 * JupyterLab under our proxy path. Token auth is added by our proxy, never by the browser.
 */
/**
 * Training jobs: keep the job credentials in /workspace/aim (0600, survives stop/start), then run the
 * recipe bootstrap in the background so JupyterLab still comes up. Restarts reuse the saved bootstrap
 * once its presigned link has expired.
 */
const TRAINING_PRELUDE = [
  'if [ -n "$AIM_TRAINING_BOOTSTRAP_URL" ]; then',
  'mkdir -p /workspace/aim',
  '&& printf "%s\\n" "AIM_TRAINING_MANIFEST_URL=$AIM_TRAINING_MANIFEST_URL" "AIM_JOB_TOKEN=$AIM_JOB_TOKEN" > /workspace/aim/job.env',
  '&& chmod 600 /workspace/aim/job.env',
  '&& (curl -fsSL "$AIM_TRAINING_BOOTSTRAP_URL" -o /workspace/aim/bootstrap.py.new && mv /workspace/aim/bootstrap.py.new /workspace/aim/bootstrap.py || true)',
  '&& (nohup python3 /workspace/aim/bootstrap.py >> /workspace/aim/bootstrap.log 2>&1 &);',
  'fi',
].join(' ');

function buildDockerArgs(rentalId, { training = false } = {}) {
  const script = [
    'for v in $(env | grep -o "^RUNPOD_[A-Za-z0-9_]*"); do unset "$v"; done',
    'unset PUBLIC_KEY JUPYTER_PASSWORD',
    'T="$AIM_ACCESS_TOKEN"; unset AIM_ACCESS_TOKEN',
    'export SHELL=/bin/bash',
    'mkdir -p /workspace && cd /workspace',
    ...(training ? [TRAINING_PRELUDE] : []),
    'unset AIM_TRAINING_BOOTSTRAP_URL AIM_TRAINING_MANIFEST_URL AIM_JOB_TOKEN',
    'command -v jupyter >/dev/null 2>&1 || pip install -q jupyterlab',
    [
      'exec jupyter lab --allow-root --no-browser --ip=0.0.0.0',
      `--port=${JUPYTER_PORT}`,
      `--ServerApp.base_url=${jupyterBasePath(rentalId)}`,
      '--ServerApp.token="$T"',
      '--ServerApp.allow_origin=*',
      '--ServerApp.allow_remote_access=True',
      '--ServerApp.trust_xheaders=True',
      '--ServerApp.root_dir=/workspace',
      '--FileContentsManager.delete_to_trash=False',
    ].join(' '),
  ].join('; ');
  return `bash -c '${script}'`;
}

/** Whitelist of variables a training job may add to the pod environment. */
function trainingEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const out = {};
  for (const key of ['AIM_TRAINING_BOOTSTRAP_URL', 'AIM_TRAINING_MANIFEST_URL', 'AIM_JOB_TOKEN']) {
    if (env[key]) out[key] = String(env[key]);
  }
  return out;
}

// ---------- balance ----------

async function availableFor(userId) {
  return (await getAvailableBalance(userId)).available;
}

async function assertPrepay(userId, pricePerHour) {
  const cfg = gpuRentalConfig();
  const need = roundMoney(pricePerHour * cfg.minPrepayHours);
  const available = await availableFor(userId);
  if (available + 1e-9 < need) {
    throw httpError(402, 'INSUFFICIENT_WALLET', { body: { available, amount: need, currency: 'USD' } });
  }
  return available;
}

// ---------- billing ----------

/** Pure accrual: whole minutes since the cursor at `rate` USD/hour, charged in cents. */
function accrue({ billedUntil, carry = 0 }, rate, now = new Date()) {
  const from = new Date(billedUntil);
  const minutes = Math.floor((now.getTime() - from.getTime()) / 60_000);
  if (minutes < 1) return { minutes: 0, charge: 0, carry, to: from };
  const accrued = (minutes * Math.max(0, rate)) / 60 + (Number(carry) || 0);
  const charge = Math.floor(Math.round(accrued * 1e6) / 1e4) / 100;
  return {
    minutes,
    charge,
    carry: Math.max(0, Math.round((accrued - charge) * 1e6) / 1e6),
    to: new Date(from.getTime() + minutes * 60_000),
  };
}

function rateFor(rental) {
  if (rental.status === 'creating' || rental.status === 'running') return rental.pricePerHour;
  if (rental.status === 'stopped' || rental.status === 'error') return rental.stoppedPricePerHour;
  return 0;
}

/**
 * Charge everything up to `now` at the rental's current rate. The cursor moves with a
 * compare-and-set so concurrent ticks/replicas can never double-charge a minute.
 */
async function settle(rental, now = new Date()) {
  const rate = rateFor(rental);
  const a = accrue(rental, rate, now);
  if (!a.minutes) return 0;
  const moved = await GpuRental.findOneAndUpdate(
    { _id: rental._id, billedUntil: rental.billedUntil },
    { $set: { billedUntil: a.to, carry: a.carry }, $inc: { billedMinutes: rate > 0 ? a.minutes : 0, billedTotal: a.charge } },
    { new: true }
  );
  if (!moved) return 0;
  rental.billedUntil = moved.billedUntil;
  rental.carry = moved.carry;
  rental.billedMinutes = moved.billedMinutes;
  rental.billedTotal = moved.billedTotal;
  if (a.charge > 0) {
    await WalletTx.create({
      user: rental.owner,
      type: 'debit',
      amount: a.charge,
      currency: 'USD',
      status: 'completed',
      note: `GPU ${rental.gpuName || rental.offerId} · ${rental.name} (${a.minutes}m${rental.status === 'stopped' ? ', storage' : ''})`,
      meta: {
        channel: 'gpu-rental',
        rentalId: String(rental._id),
        minutes: a.minutes,
        rate,
        from: new Date(a.to.getTime() - a.minutes * 60_000),
        to: a.to,
      },
    });
  }
  return a.charge;
}

// ---------- lifecycle ----------

async function findOwned(user, id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) throw httpError(404, 'RENTAL_NOT_FOUND');
  const q = { _id: id };
  if (user.role !== 'admin') q.owner = user._id;
  const rental = await GpuRental.findOne(q);
  if (!rental) throw httpError(404, 'RENTAL_NOT_FOUND');
  return rental;
}

async function listForUser(userId) {
  const since = new Date(Date.now() - 7 * 86_400_000);
  return GpuRental.find({
    owner: userId,
    $or: [{ status: { $in: ACTIVE } }, { terminatedAt: { $gte: since } }],
  }).sort({ createdAt: -1 });
}

/** `internal` is for server-side callers only (training jobs); never pass request data into it. */
async function createRental(user, body = {}, internal = {}) {
  const cfg = gpuRentalConfig();
  const offerId = String(body.offerId || body.gpuId || '').trim();
  const offers = await listOffers();
  const offer = offers.find((o) => String(o.id) === offerId);
  if (!offer) throw httpError(400, 'OFFER_NOT_FOUND');
  const gpuCount = Math.min(cfg.maxGpuCount, Math.max(1, Math.round(Number(body.gpuCount) || 1)));
  const volumeGb = Math.min(
    cfg.volumeGbMax,
    Math.max(cfg.volumeGbMin, Math.round(Number(body.volumeGb) || cfg.volumeGbDefault))
  );
  const active = await GpuRental.countDocuments({ owner: user._id, status: { $in: ACTIVE } });
  if (active >= cfg.maxActivePerUser) throw httpError(409, 'RENTAL_LIMIT', { body: { limit: cfg.maxActivePerUser } });

  const prices = quote({ costPerHour: offer.costPerHour, gpuCount, diskGb: cfg.diskGb, volumeGb }, cfg);
  await assertPrepay(user._id, prices.pricePerHour);

  const now = new Date();
  const rental = await GpuRental.create({
    owner: user._id,
    name: String(body.name || `${offer.name} workspace`).trim().slice(0, 80) || 'GPU workspace',
    offerId: offer.id,
    gpuName: offer.name,
    gpuMemoryGb: offer.memoryGb || 0,
    gpuCount,
    diskGb: cfg.diskGb,
    volumeGb,
    costPerHour: offer.costPerHour * gpuCount,
    ...prices,
    billedUntil: now,
    accessToken: crypto.randomBytes(24).toString('hex'),
  });

  try {
    const server = await provider.createServer({
      name: `aim-${String(rental._id).slice(-10)}`,
      kind: 'compute',
      gpuType: offer.id,
      gpuCount,
      image: cfg.image,
      diskGb: cfg.diskGb,
      volumeGb,
      volumeMountPath: '/workspace',
      ports: `${JUPYTER_PORT}/http`,
      env: { ...trainingEnv(internal.trainingEnv), AIM_ACCESS_TOKEN: rental.accessToken },
      dockerArgs: buildDockerArgs(String(rental._id), { training: Boolean(internal.trainingEnv) }),
    });
    if (!server.id) throw provider.providerError(502, 'PROVIDER_ERROR');
    rental.providerServerId = server.id;
    rental.status = server.status === 'running' ? 'running' : 'creating';
    rental.ready = false;
    if (server.costPerHour > 0 && Math.abs(server.costPerHour - rental.costPerHour) > 1e-6) {
      rental.costPerHour = server.costPerHour;
      Object.assign(rental, quote({ costPerHour: server.costPerHour / gpuCount, gpuCount, diskGb: cfg.diskGb, volumeGb }, cfg));
    }
    // Upstream bills from creation; so do we (cursor starts at `now`).
    await rental.save();
    return rental;
  } catch (err) {
    rental.status = 'terminated';
    rental.terminatedAt = new Date();
    rental.lastError = String(err.code || 'PROVIDER_ERROR').slice(0, 120);
    await rental.save();
    throw err.status ? err : httpError(502, 'PROVIDER_ERROR');
  }
}

/** Pull live status from upstream; marks vanished pods as terminated. */
async function refreshRental(rental) {
  if (!rental.providerServerId || rental.status === 'terminated') return rental;
  try {
    const live = await provider.getServer(rental.providerServerId);
    if (live.status === 'terminated') {
      await settle(rental);
      rental.status = 'terminated';
      rental.terminatedAt = rental.terminatedAt || new Date();
    } else if (live.status === 'running' || live.status === 'creating') {
      if (rental.status === 'creating' || rental.status === 'running') {
        rental.status = live.status === 'running' ? 'running' : 'creating';
        rental.ready = live.status === 'running' && live.ready;
      }
    } else if (live.status === 'stopped' && rental.status !== 'stopped') {
      await settle(rental);
      rental.status = 'stopped';
      rental.ready = false;
      rental.stoppedAt = rental.stoppedAt || new Date();
      rental.stoppedReason = rental.stoppedReason || 'user';
    }
    await rental.save();
  } catch (err) {
    if (err.code === 'SERVER_NOT_FOUND') {
      await settle(rental);
      rental.status = 'terminated';
      rental.ready = false;
      rental.terminatedAt = rental.terminatedAt || new Date();
      await rental.save();
    }
  }
  return rental;
}

async function startRental(rental) {
  if (rental.status === 'terminated') throw httpError(409, 'RENTAL_TERMINATED');
  if (rental.status === 'running' || rental.status === 'creating') return rental;
  await settle(rental);
  await assertPrepay(rental.owner, rental.pricePerHour);
  await provider.startServer(rental.providerServerId, rental.gpuCount);
  rental.status = 'creating';
  rental.ready = false;
  rental.stoppedReason = '';
  rental.stoppedAt = null;
  rental.terminateAfter = null;
  rental.lowBalanceWarnedAt = null;
  await rental.save();
  return rental;
}

async function stopRental(rental, reason = 'user') {
  if (rental.status === 'terminated') throw httpError(409, 'RENTAL_TERMINATED');
  if (rental.status === 'stopped') return rental;
  await settle(rental);
  await provider.stopServer(rental.providerServerId);
  rental.status = 'stopped';
  rental.ready = false;
  rental.stoppedReason = reason;
  rental.stoppedAt = new Date();
  if (reason === 'insufficient_funds') {
    rental.terminateAfter = new Date(Date.now() + gpuRentalConfig().terminateGraceMs);
  }
  await rental.save();
  return rental;
}

async function terminateRental(rental) {
  if (rental.status === 'terminated') return rental;
  await settle(rental);
  if (rental.providerServerId) {
    try {
      await provider.terminateServer(rental.providerServerId);
    } catch (err) {
      if (err.code !== 'SERVER_NOT_FOUND') throw err;
    }
  }
  rental.status = 'terminated';
  rental.ready = false;
  rental.terminatedAt = new Date();
  rental.terminateAfter = null;
  await rental.save();
  return rental;
}

// ---------- billing tick ----------

async function enforceBalance(rental, now = new Date()) {
  const cfg = gpuRentalConfig();
  const available = await availableFor(rental.owner);
  const href = '/gpu';

  if (rental.status === 'creating' || rental.status === 'running') {
    const perMinute = rental.pricePerHour / 60;
    if (available < perMinute) {
      await stopRental(rental, 'insufficient_funds');
      await notifyUser(rental.owner, 'gpu.stoppedNoFunds', { name: rental.name, hours: Math.round(cfg.terminateGraceMs / 3_600_000) }, href);
      return 'stopped';
    }
    if (available < perMinute * cfg.warnMinutes) {
      if (!rental.lowBalanceWarnedAt) {
        rental.lowBalanceWarnedAt = now;
        await rental.save();
        await notifyUser(rental.owner, 'gpu.lowBalance', { name: rental.name, minutes: Math.max(1, Math.floor(available / perMinute)) }, href);
      }
    } else if (rental.lowBalanceWarnedAt && available >= perMinute * cfg.warnMinutes * 2) {
      rental.lowBalanceWarnedAt = null;
      await rental.save();
    }
    return 'ok';
  }

  if (rental.status === 'stopped' || rental.status === 'error') {
    const graceHours = cfg.terminateGraceMs / 3_600_000;
    if (available > 0 && available >= rental.stoppedPricePerHour * graceHours) {
      if (rental.terminateAfter) {
        rental.terminateAfter = null;
        await rental.save();
      }
      return 'ok';
    }
    if (!rental.terminateAfter) {
      rental.terminateAfter = new Date(now.getTime() + cfg.terminateGraceMs);
      await rental.save();
      return 'grace';
    }
    if (rental.terminateAfter <= now) {
      await terminateRental(rental);
      await notifyUser(rental.owner, 'gpu.terminatedNoFunds', { name: rental.name }, href);
      return 'terminated';
    }
    return 'grace';
  }
  return 'ok';
}

async function tickRental(rental, now = new Date()) {
  if (rental.status === 'creating' || (rental.status === 'running' && !rental.ready)) await refreshRental(rental);
  if (rental.status === 'terminated') return 'terminated';
  await settle(rental, now);
  return enforceBalance(rental, now);
}

async function runBillingTick(now = new Date()) {
  const rows = await GpuRental.find({ status: { $in: ACTIVE } });
  const out = { total: rows.length, stopped: 0, terminated: 0, errors: 0 };
  for (const rental of rows) {
    try {
      const r = await tickRental(rental, now);
      if (r === 'stopped') out.stopped += 1;
      if (r === 'terminated') out.terminated += 1;
    } catch (err) {
      out.errors += 1;
      console.error('[gpu-rental] tick failed', String(rental._id), err.code || err.message);
    }
  }
  return out;
}

let timer = null;
let busy = false;

function startBillingWorker() {
  if (timer) return timer;
  const { tickMs } = gpuRentalConfig();
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await runBillingTick();
      if (r.stopped || r.terminated || r.errors) console.log('[gpu-rental] tick', JSON.stringify(r));
    } catch (err) {
      console.error('[gpu-rental] tick error', err.message);
    } finally {
      busy = false;
    }
  }, tickMs);
  timer.unref?.();
  return timer;
}

function stopBillingWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  ACTIVE,
  JUPYTER_PORT,
  jupyterBasePath,
  publicOffers,
  listOffers,
  resetOffersCache,
  publicRental,
  buildDockerArgs,
  accrue,
  settle,
  findOwned,
  listForUser,
  createRental,
  refreshRental,
  startRental,
  stopRental,
  terminateRental,
  enforceBalance,
  tickRental,
  runBillingTick,
  startBillingWorker,
  stopBillingWorker,
};
