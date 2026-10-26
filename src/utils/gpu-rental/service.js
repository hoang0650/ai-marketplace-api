const crypto = require('crypto');
const GpuRental = require('../../models/GpuRental');
const GpuVolume = require('../../models/GpuVolume');
const WalletTx = require('../../models/WalletTx');
const { getAvailableBalance, getSpendableBalance } = require('../wallet');
const { withWalletLock } = require('../wallet-lock');
const { roundMoney } = require('../payout-hold');
const { notifyUser } = require('../notify');
const { gpuRentalConfig } = require('./config');
const { quote, toOffer, isFitGpu, rowClouds, volumeQuote, availabilityOf } = require('./pricing');
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

// Live upstream catalog (GPU types × cloud × data center), cached for offersTtlMs. No static fallback.
let catalogCache = { at: 0, rows: [], dataCenters: [] };

async function loadCatalog({ fresh = false } = {}) {
  const cfg = gpuRentalConfig();
  if (!fresh && catalogCache.rows.length && Date.now() - catalogCache.at < cfg.offersTtlMs) return catalogCache;
  const cat = await provider.gpuCatalog();
  const rows = (cat.gpuTypes || []).filter((r) => isFitGpu(r, cfg));
  catalogCache = { at: Date.now(), rows, dataCenters: cat.dataCenters || [] };
  return catalogCache;
}

/** Internal rows (with upstream costs) of rentable GPUs. */
async function listOffers(opts = {}) {
  return (await loadCatalog(opts)).rows;
}

async function publicOffers() {
  const cfg = gpuRentalConfig();
  const rows = await listOffers();
  return rows.map((r) => toOffer(r, cfg)).filter(Boolean);
}

/** Data centers that support network volumes, with how many rentable GPU types are in stock there. */
async function publicDataCenters() {
  const cfg = gpuRentalConfig();
  const { rows, dataCenters } = await loadCatalog();
  const out = [];
  for (const dc of dataCenters) {
    if (!dc.storageSupport) continue;
    const gpus = rows.filter((r) =>
      (rowClouds(r).secure?.dataCenters || []).some((d) => d.id === dc.id && availabilityOf(d.stock) !== 'unknown')
    );
    out.push({
      id: String(dc.id),
      location: String(dc.location || ''),
      gpuCount: gpus.length,
      cheapestPricePerHour: gpus.length
        ? Math.min(...gpus.map((r) => quote({ costPerHour: rowClouds(r).secure.costPerHour, volumeGb: 0 }, cfg).pricePerHour))
        : null,
    });
  }
  return out.sort((a, b) => b.gpuCount - a.gpuCount || a.id.localeCompare(b.id));
}

function resetOffersCache() {
  catalogCache = { at: 0, rows: [], dataCenters: [] };
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
    cloudType: doc.cloudType || 'secure',
    dataCenterId: doc.dataCenterId || '',
    networkVolume:
      doc.volume && doc.$locals && doc.$locals.volume
        ? { id: String(doc.volume), name: doc.$locals.volume.name, sizeGb: doc.$locals.volume.sizeGb, mountPath: '/workspace' }
        : doc.volume
          ? { id: String(doc.volume), mountPath: '/workspace' }
          : null,
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
    ...(doc.$locals && doc.$locals.live ? { live: liveInfo(doc) } : {}),
  };
}

/** Owner-only live pod facts for the terminal status bar (set by refreshRental). */
function liveInfo(doc) {
  const live = doc.$locals.live || {};
  return {
    podId: String(doc.providerServerId || ''),
    dataCenterId: live.dataCenterId || '',
    uptimeSeconds: live.uptimeSeconds || 0,
    gpuUtilPercent: live.gpuUtilPercent ?? null,
    memoryUtilPercent: live.memoryUtilPercent ?? null,
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

function toCents(amount, up = false) {
  const micro = Math.round(amount * 1e6) / 1e4;
  return (up ? Math.ceil(micro - 1e-9) : Math.floor(micro + 1e-9)) / 100;
}

/**
 * Pure accrual: whole minutes since the cursor at `rate` USD/hour, charged in cents.
 * `final` (stop / terminate / state change) bills the last partial minute and rounds
 * the sub-cent carry up, so a rental never ends with unbilled time.
 */
function accrue({ billedUntil, carry = 0 }, rate, now = new Date(), { final = false } = {}) {
  const from = new Date(billedUntil);
  const ms = now.getTime() - from.getTime();
  const prevCarry = Number(carry) || 0;
  let minutes = ms > 0 ? Math.floor(ms / 60_000) : 0;
  if (final && ms > 0 && ms % 60_000 > 0) minutes += 1;
  if (minutes < 1) {
    if (final && prevCarry > 0) return { minutes: 0, charge: toCents(prevCarry, true), carry: 0, to: from };
    return { minutes: 0, charge: 0, carry, to: from };
  }
  const accrued = (minutes * Math.max(0, rate)) / 60 + prevCarry;
  const charge = toCents(accrued, final);
  return {
    minutes,
    charge,
    carry: final ? 0 : Math.max(0, Math.round((accrued - charge) * 1e6) / 1e6),
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
async function settle(rental, now = new Date(), opts = {}) {
  const rate = rateFor(rental);
  const attempts = opts.final ? 4 : 1;
  for (let i = 0; i < attempts; i += 1) {
    const a = accrue(rental, rate, now, opts);
    if (!a.minutes && !a.charge) return 0;
    const moved = await GpuRental.findOneAndUpdate(
      { _id: rental._id, billedUntil: rental.billedUntil },
      { $set: { billedUntil: a.to, carry: a.carry }, $inc: { billedMinutes: rate > 0 ? a.minutes : 0, billedTotal: a.charge } },
      { new: true }
    );
    if (!moved) {
      // Lost the CAS to a concurrent tick: on the final settle reload and bill the remaining tail.
      if (i + 1 >= attempts) return 0;
      const fresh = await GpuRental.findById(rental._id).lean();
      if (!fresh) return 0;
      rental.billedUntil = fresh.billedUntil;
      rental.carry = fresh.carry;
      continue;
    }
    rental.billedUntil = moved.billedUntil;
    rental.carry = moved.carry;
    rental.billedMinutes = moved.billedMinutes;
    rental.billedTotal = moved.billedTotal;
    if (a.charge > 0) await debitRental(rental, a, rate);
    return a.charge;
  }
  return 0;
}

/** Debit under the wallet lock, capped at what the owner can cover (never below zero). */
async function debitRental(rental, a, rate) {
  return withWalletLock(rental.owner, async () => {
    const spendable = await getSpendableBalance(rental.owner);
    const amount = Math.min(a.charge, Math.floor(spendable * 100 + 1e-9) / 100);
    const shortfall = Math.round((a.charge - amount) * 100) / 100;
    if (!(amount > 0)) {
      console.warn('[gpu-rental] unbilled (no funds)', String(rental._id), a.charge);
      return 0;
    }
    await WalletTx.create({
      user: rental.owner,
      type: 'debit',
      amount,
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
        ...(shortfall > 0 ? { shortfall } : {}),
      },
    });
    return amount;
  });
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
  const clouds = rowClouds(offer);
  const sellable = (t) => clouds[t] && Number(clouds[t].costPerHour) > 0 && availabilityOf(clouds[t].stock) !== 'unknown';

  // Optional network volume: secure cloud only, pod pinned to the volume's data center.
  let volume = null;
  if (body.volumeId) {
    volume = await findOwnedVolume(user, body.volumeId);
    if (volume.status !== 'active') throw httpError(409, 'VOLUME_NOT_READY');
    const busy = await GpuRental.countDocuments({ volume: volume._id, status: { $in: ACTIVE } });
    if (busy) throw httpError(409, 'VOLUME_IN_USE');
    const inDc = (clouds.secure?.dataCenters || []).some(
      (d) => d.id === volume.dataCenterId && availabilityOf(d.stock) !== 'unknown'
    );
    if (!sellable('secure') || !inDc) throw httpError(409, 'GPU_UNAVAILABLE_IN_DC', { body: { dataCenterId: volume.dataCenterId } });
  }
  const wanted = volume ? 'secure' : String(body.cloud || body.cloudType || '').toLowerCase();
  const cloudType = sellable(wanted) ? wanted : ['secure', 'community'].find(sellable);
  if (!cloudType || (wanted && wanted !== cloudType && body.cloud)) throw httpError(409, 'GPU_UNAVAILABLE');
  const cost = Number(clouds[cloudType].costPerHour);

  const gpuCount = Math.min(cfg.maxGpuCount, Math.max(1, Math.round(Number(body.gpuCount) || 1)));
  // With a network volume /workspace lives on the volume (billed separately), so no pod volume.
  const volumeGb = volume
    ? 0
    : Math.min(cfg.volumeGbMax, Math.max(cfg.volumeGbMin, Math.round(Number(body.volumeGb) || cfg.volumeGbDefault)));
  const active = await GpuRental.countDocuments({ owner: user._id, status: { $in: ACTIVE } });
  if (active >= cfg.maxActivePerUser) throw httpError(409, 'RENTAL_LIMIT', { body: { limit: cfg.maxActivePerUser } });

  const prices = quote({ costPerHour: cost, gpuCount, diskGb: cfg.diskGb, volumeGb }, cfg);
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
    cloudType,
    volume: volume ? volume._id : null,
    dataCenterId: volume ? volume.dataCenterId : '',
    costPerHour: cost * gpuCount,
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
      cloudType: cloudType.toUpperCase(),
      ...(volume ? { networkVolumeId: volume.providerVolumeId, dataCenterIds: [volume.dataCenterId] } : {}),
      ports: `${JUPYTER_PORT}/http`,
      env: { ...trainingEnv(internal.trainingEnv), AIM_ACCESS_TOKEN: rental.accessToken },
      dockerArgs: buildDockerArgs(String(rental._id), { training: Boolean(internal.trainingEnv) }),
    });
    if (!server.id) throw provider.providerError(502, 'PROVIDER_ERROR');
    rental.providerServerId = server.id;
    rental.status = server.status === 'running' ? 'running' : 'creating';
    rental.ready = false;
    if (server.dataCenterId) rental.dataCenterId = server.dataCenterId;
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
    if (rental.$locals) rental.$locals.live = live;
    if (live.dataCenterId && !rental.dataCenterId) rental.dataCenterId = live.dataCenterId;
    if (live.status === 'terminated') {
      await settle(rental, new Date(), { final: true });
      rental.status = 'terminated';
      rental.terminatedAt = rental.terminatedAt || new Date();
    } else if (live.status === 'running' || live.status === 'creating') {
      if (rental.status === 'creating' || rental.status === 'running') {
        rental.status = live.status === 'running' ? 'running' : 'creating';
        rental.ready = live.status === 'running' && live.ready;
      }
    } else if (live.status === 'stopped' && rental.status !== 'stopped') {
      await settle(rental, new Date(), { final: true });
      rental.status = 'stopped';
      rental.ready = false;
      rental.stoppedAt = rental.stoppedAt || new Date();
      rental.stoppedReason = rental.stoppedReason || 'user';
    }
    await rental.save();
  } catch (err) {
    if (err.code === 'SERVER_NOT_FOUND') {
      await settle(rental, new Date(), { final: true });
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
  if (rental.volume && rental.status !== 'running' && rental.status !== 'creating') throw httpError(409, 'RENTAL_TERMINATED');
  if (rental.status === 'running' || rental.status === 'creating') return rental;
  await settle(rental, new Date(), { final: true });
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
  if (rental.volume) {
    // Pods with a network volume cannot be stopped upstream: end the pod, the data stays on the volume.
    rental.stoppedReason = reason;
    rental.stoppedAt = new Date();
    return terminateRental(rental);
  }
  await settle(rental, new Date(), { final: true });
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
  await settle(rental, new Date(), { final: true });
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

// ---------- network volumes ----------

const VOLUME_LIVE = ['creating', 'active', 'error'];

async function findOwnedVolume(user, id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) throw httpError(404, 'VOLUME_NOT_FOUND');
  const q = { _id: id, status: { $in: VOLUME_LIVE } };
  if (user.role !== 'admin') q.owner = user._id;
  const vol = await GpuVolume.findOne(q);
  if (!vol) throw httpError(404, 'VOLUME_NOT_FOUND');
  return vol;
}

function publicVolume(doc, attached = null) {
  const q = volumeQuote(doc.sizeGb);
  return {
    id: String(doc._id || doc.id),
    name: doc.name,
    dataCenterId: doc.dataCenterId,
    sizeGb: doc.sizeGb,
    mountPath: '/workspace',
    status: doc.status,
    pricePerHour: doc.pricePerHour,
    pricePerMonth: q.pricePerMonth,
    pricePerGbMonth: doc.pricePerGbMonth || q.pricePerGbMonth,
    currency: 'USD',
    billedMinutes: doc.billedMinutes || 0,
    billedTotal: roundMoney(doc.billedTotal || 0),
    terminateAfter: doc.terminateAfter || null,
    attachedRentalId: attached ? String(attached) : null,
    createdAt: doc.createdAt,
  };
}

/** Attach volume name/size to rentals for serialization (owner views only). */
async function attachVolumes(rentals) {
  const ids = [...new Set(rentals.filter((r) => r.volume).map((r) => String(r.volume)))];
  if (!ids.length) return rentals;
  const vols = await GpuVolume.find({ _id: { $in: ids } }, { name: 1, sizeGb: 1 }).lean();
  const byId = new Map(vols.map((v) => [String(v._id), v]));
  for (const r of rentals) if (r.volume && r.$locals) r.$locals.volume = byId.get(String(r.volume)) || null;
  return rentals;
}

async function listVolumes(userId) {
  const vols = await GpuVolume.find({ owner: userId, status: { $in: VOLUME_LIVE } }).sort({ createdAt: -1 });
  const using = await GpuRental.find({ volume: { $in: vols.map((v) => v._id) }, status: { $in: ACTIVE } }, { volume: 1 }).lean();
  const byVol = new Map(using.map((r) => [String(r.volume), r._id]));
  return vols.map((v) => publicVolume(v, byVol.get(String(v._id))));
}

function volumeLimits() {
  const cfg = gpuRentalConfig();
  return {
    sizeMin: cfg.volumeSizeMin,
    sizeMax: cfg.volumeSizeMax,
    sizeDefault: cfg.volumeSizeDefault,
    maxPerUser: cfg.maxVolumesPerUser,
    pricePerGbMonth: volumeQuote(1, cfg).pricePerGbMonth,
    mountPath: '/workspace',
  };
}

async function createVolume(user, body = {}) {
  const cfg = gpuRentalConfig();
  const sizeGb = Math.round(Number(body.sizeGb));
  if (!Number.isFinite(sizeGb) || sizeGb < cfg.volumeSizeMin || sizeGb > cfg.volumeSizeMax) {
    throw httpError(400, 'VOLUME_SIZE_INVALID', { body: { min: cfg.volumeSizeMin, max: cfg.volumeSizeMax } });
  }
  const dataCenterId = String(body.dataCenterId || '').trim();
  const dcs = await publicDataCenters();
  if (!dcs.some((d) => d.id === dataCenterId)) throw httpError(400, 'DATA_CENTER_INVALID');
  const count = await GpuVolume.countDocuments({ owner: user._id, status: { $in: VOLUME_LIVE } });
  if (count >= cfg.maxVolumesPerUser) throw httpError(409, 'VOLUME_LIMIT', { body: { limit: cfg.maxVolumesPerUser } });
  const q = volumeQuote(sizeGb, cfg);
  const need = Math.max(0.01, roundMoney(q.pricePerHour * cfg.volumePrepayHours));
  const available = await availableFor(user._id);
  if (available + 1e-9 < need) throw httpError(402, 'INSUFFICIENT_WALLET', { body: { available, amount: need, currency: 'USD' } });

  const name = String(body.name || '').trim().replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 40) || `Volume ${dataCenterId}`;
  const vol = await GpuVolume.create({
    owner: user._id,
    name,
    dataCenterId,
    sizeGb,
    costPerGbMonth: cfg.volumeGbMonth,
    pricePerGbMonth: q.pricePerGbMonth,
    pricePerHour: q.pricePerHour,
    billedUntil: new Date(),
  });
  try {
    const up = await provider.createVolume({ name: `aim-vol-${String(vol._id).slice(-12)}`, sizeGb, dataCenterId });
    if (!up.id) throw provider.providerError(502, 'PROVIDER_ERROR');
    vol.providerVolumeId = up.id;
    vol.status = 'active';
    vol.billedUntil = new Date();
    await vol.save();
    return vol;
  } catch (err) {
    vol.status = 'error';
    vol.lastError = String(err.code || 'PROVIDER_ERROR').slice(0, 120);
    vol.deletedAt = new Date();
    vol.status = 'deleted';
    await vol.save();
    throw err.status ? err : httpError(502, 'PROVIDER_ERROR');
  }
}

/** Per-minute storage billing with the same CAS cursor as rentals (WalletTx channel gpu-volume). */
async function settleVolume(vol, now = new Date(), opts = {}) {
  const rate = vol.status === 'active' ? vol.pricePerHour : 0;
  const a = accrue(vol, rate, now, opts);
  if (!a.minutes && !a.charge) return 0;
  const moved = await GpuVolume.findOneAndUpdate(
    { _id: vol._id, billedUntil: vol.billedUntil },
    { $set: { billedUntil: a.to, carry: a.carry }, $inc: { billedMinutes: rate > 0 ? a.minutes : 0, billedTotal: a.charge } },
    { new: true }
  );
  if (!moved) return 0;
  vol.billedUntil = moved.billedUntil;
  vol.carry = moved.carry;
  vol.billedMinutes = moved.billedMinutes;
  vol.billedTotal = moved.billedTotal;
  if (!(a.charge > 0)) return 0;
  return withWalletLock(vol.owner, async () => {
    const spendable = await getSpendableBalance(vol.owner);
    const amount = Math.min(a.charge, Math.floor(spendable * 100 + 1e-9) / 100);
    if (!(amount > 0)) return 0;
    await WalletTx.create({
      user: vol.owner,
      type: 'debit',
      amount,
      currency: 'USD',
      status: 'completed',
      note: `Network volume ${vol.name} · ${vol.sizeGb} GB ${vol.dataCenterId} (${a.minutes}m)`,
      meta: {
        channel: 'gpu-volume',
        volumeId: String(vol._id),
        minutes: a.minutes,
        rate,
        from: new Date(a.to.getTime() - a.minutes * 60_000),
        to: a.to,
      },
    });
    return amount;
  });
}

async function deleteVolume(vol, { force = false } = {}) {
  if (vol.status === 'deleted') return vol;
  const busy = await GpuRental.countDocuments({ volume: vol._id, status: { $in: ACTIVE } });
  if (busy && !force) throw httpError(409, 'VOLUME_IN_USE');
  await settleVolume(vol, new Date(), { final: true });
  if (vol.providerVolumeId) await provider.deleteVolume(vol.providerVolumeId);
  vol.status = 'deleted';
  vol.deletedAt = new Date();
  vol.terminateAfter = null;
  await vol.save();
  return vol;
}

/** Storage keeps running while the wallet covers it; otherwise grace, then delete (pods on it end first). */
async function tickVolume(vol, now = new Date()) {
  const cfg = gpuRentalConfig();
  await settleVolume(vol, now);
  const available = await availableFor(vol.owner);
  if (available > 0 && available >= vol.pricePerHour) {
    if (vol.terminateAfter) {
      vol.terminateAfter = null;
      await vol.save();
    }
    return 'ok';
  }
  if (!vol.terminateAfter) {
    vol.terminateAfter = new Date(now.getTime() + cfg.terminateGraceMs);
    await vol.save();
    await notifyUser(vol.owner, 'gpu.stoppedNoFunds', { name: vol.name, hours: Math.round(cfg.terminateGraceMs / 3_600_000) }, '/training/gpu');
    return 'grace';
  }
  if (vol.terminateAfter <= now) {
    const pods = await GpuRental.find({ volume: vol._id, status: { $in: ACTIVE } });
    for (const r of pods) await terminateRental(r);
    await deleteVolume(vol, { force: true });
    await notifyUser(vol.owner, 'gpu.terminatedNoFunds', { name: vol.name }, '/training/gpu');
    return 'deleted';
  }
  return 'grace';
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
  const vols = await GpuVolume.find({ status: 'active' });
  out.volumes = vols.length;
  for (const vol of vols) {
    try {
      if ((await tickVolume(vol, now)) === 'deleted') out.terminated += 1;
    } catch (err) {
      out.errors += 1;
      console.error('[gpu-rental] volume tick failed', String(vol._id), err.code || err.message);
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
  publicDataCenters,
  listOffers,
  findOwnedVolume,
  publicVolume,
  listVolumes,
  attachVolumes,
  volumeLimits,
  createVolume,
  settleVolume,
  deleteVolume,
  tickVolume,
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
