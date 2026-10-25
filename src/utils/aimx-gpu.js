/** Client + launch-promo config for the self-hosted RTX 5090 job service (video, voice, training). */
const SHARED_OFFER_ID = 'aimx-5090';

/**
 * The 5090 is reached only through the AI service (ai-marketplace-ai, provider "aimx") with the
 * service-to-service key. This API holds no GPU URL or token.
 * AIMX_PROVIDER_URL (default DENGLISH_API_URL) + DENGLISH_SERVICE_KEY; AIMX_STUDIO=off disables.
 */
function gpuConfig(env = process.env) {
  const url = (env.AIMX_PROVIDER_URL || env.DENGLISH_API_URL || '').trim().replace(/\/$/, '');
  const key = (env.DENGLISH_SERVICE_KEY || env.AIMARKETS_AI_SERVICE_KEY || '').trim();
  return { url, enabled: Boolean(url && key && env.AIMX_STUDIO !== 'off'), key };
}

/** Worker-style paths used by the routes -> AI service provider routes. */
function providerPath(path) {
  const p = String(path || '');
  const submit = { '/v1/video/fast': 'fast', '/v1/video/talking': 'talking', '/v1/tts': 'tts', '/v1/film': 'film', '/v1/train': 'train' }[p];
  if (submit) return `/providers/aimx/jobs/${submit}`;
  if (p === '/v1/voices') return '/providers/aimx/voices';
  if (p === '/v1/voice-options') return '/providers/aimx/voice-options';
  if (p === '/health') return '/providers/aimx/health';
  // AI Film on RunPod public endpoints (Wan 2.2 I2V / Qwen-Image-Edit) + ffmpeg joins in the AI service.
  let f = p.match(/^\/film\/(health|plan|image|scene|render|probe)$/);
  if (f) return `/providers/aimx/film/${f[1]}`;
  f = p.match(/^\/film\/jobs\/([a-f0-9]{32})$/);
  if (f) return `/providers/aimx/film/jobs/${f[1]}`;
  let m = p.match(/^\/v1\/jobs\/([a-f0-9]{32})(\/cancel)?$/);
  if (m) return `/providers/aimx/jobs/${m[1]}${m[2] || ''}`;
  m = p.match(/^\/v1\/files\/([a-f0-9]{32}\.[a-z0-9.]+)$/);
  if (m) return `/providers/aimx/files/${m[1]}`;
  return null;
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
  const target = providerPath(path);
  if (!g.enabled || !target) {
    const e = new Error(g.enabled ? 'Unsupported GPU path' : 'GPU service is not configured');
    e.status = 503; e.code = 'STUDIO_UNAVAILABLE';
    throw e;
  }
  return fetch(g.url + target, {
    ...opts,
    headers: { 'X-Service-Key': g.key, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 30000),
  });
}

module.exports = { SHARED_OFFER_ID, gpuConfig, providerPath, promoActive, promoInfo, trainingLimits, trainingCharge, sharedOffer, gpuFetch };
