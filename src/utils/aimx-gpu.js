/** Client + launch-promo config for the self-hosted RTX 5090 job service (video, voice, training). */
const SHARED_OFFER_ID = 'aimx-5090';

function gpuConfig(env = process.env) {
  const url = (env.GPU_STUDIO_URL || '').replace(/\/$/, '');
  const token = env.GPU_STUDIO_TOKEN || '';
  return { url, token, enabled: Boolean(url && token) };
}

/** GPU_FREE_PROMO=true (+ optional GPU_FREE_PROMO_UNTIL ISO date) → no wallet charge for 5090 jobs. */
function promoActive(env = process.env, now = new Date()) {
  if (!/^(1|true|yes|on)$/i.test(String(env.GPU_FREE_PROMO || ''))) return false;
  const until = env.GPU_FREE_PROMO_UNTIL ? new Date(env.GPU_FREE_PROMO_UNTIL) : null;
  return !(until && !Number.isNaN(until.getTime()) && now > until);
}

function promoInfo(env = process.env, now = new Date()) {
  const active = promoActive(env, now);
  return {
    active,
    until: active && env.GPU_FREE_PROMO_UNTIL ? new Date(env.GPU_FREE_PROMO_UNTIL).toISOString() : null,
    label: active ? 'Miễn phí giai đoạn đầu' : '',
  };
}

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

function trainingLimits(env = process.env) {
  return {
    pricePerHour: num(env.GPU_5090_PRICE_PER_HOUR, 0.89),
    maxMinutes: num(env.GPU_TRAIN_MAX_MINUTES, 30),
    perUserDaily: num(env.GPU_TRAIN_PER_USER_DAILY, 3),
    perUserActive: num(env.GPU_TRAIN_PER_USER_ACTIVE, 1),
  };
}

/** Per-minute charge for a finished 5090 training job when the promo is off. */
function trainingCharge(seconds, pricePerHour) {
  const minutes = Math.max(1, Math.ceil((Number(seconds) || 0) / 60));
  return Math.round(minutes * (pricePerHour / 60) * 100) / 100;
}

function sharedOffer(env = process.env) {
  const promo = promoInfo(env);
  const lim = trainingLimits(env);
  return {
    id: SHARED_OFFER_ID,
    name: 'RTX 5090 · AI Markets',
    memoryGb: 32,
    gpuCount: 1,
    pricePerHour: promo.active ? 0 : lim.pricePerHour,
    listPricePerHour: lim.pricePerHour,
    availability: 'available',
    shared: true,
    promo,
    maxMinutes: lim.maxMinutes,
  };
}

async function gpuFetch(path, opts = {}) {
  const g = gpuConfig();
  if (!g.enabled) {
    const e = new Error('GPU service is not configured');
    e.status = 503; e.code = 'STUDIO_UNAVAILABLE';
    throw e;
  }
  return fetch(g.url + path, {
    ...opts,
    headers: { authorization: `Bearer ${g.token}`, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 30000),
  });
}

module.exports = { SHARED_OFFER_ID, gpuConfig, promoActive, promoInfo, trainingLimits, trainingCharge, sharedOffer, gpuFetch };
