const express = require('express');
const { authenticate } = require('../middleware/auth');
const StudioJob = require('../models/StudioJob');
const WalletTx = require('../models/WalletTx');
const { getAvailableBalance } = require('../utils/wallet');
const { studioPolicy, dayStart, decide } = require('../utils/studio-policy');

const router = express.Router();
const film = () => require('./studio-film'); // lazy: studio-film also imports this module's helpers indirectly
const LEGACY_KINDS = ['fast', 'talking', 'tts', 'film'];
const MAX_B64 = 11_000_000;

const { gpuConfig, gpuFetch, promoInfo } = require('../utils/aimx-gpu');
const { failMessage, transient } = require('../utils/studio-errors');
const { voiceLang, voiceFx } = require('../utils/voice-params');
const { charCount } = require('../utils/usage-pricing');

const RETRY_MAX_BYTES = 200_000; // retry small jobs (text-only TTS) once on transient worker errors

const gpu = () => (gpuConfig().enabled ? gpuConfig() : null);

const MESSAGES = {
  STUDIO_UNAVAILABLE: 'Máy GPU tạm thời không khả dụng, vui lòng thử lại sau.',
  INSUFFICIENT_WALLET: 'Bạn đã dùng hết lượt miễn phí hôm nay. Số dư ví không đủ để tạo thêm.',
  FREE_QUOTA_EXHAUSTED: 'Bạn đã dùng hết lượt miễn phí hôm nay.',
  JOB_ACTIVE: 'Bạn đang có một video đang tạo. Vui lòng đợi hoàn tất.',
  QUEUE_FULL: 'Hàng đợi GPU đang đầy, vui lòng thử lại sau ít phút.',
  VOICES_UNAVAILABLE: 'Chưa tải được danh sách giọng, vui lòng tải lại trang.',
  BAD_INPUT: 'Dữ liệu không hợp lệ.',
};
function fail(res, status, code, extra = {}) {
  return res.status(status).json({ code, message: MESSAGES[code] || code, ...extra });
}

function pickImage(body) {
  const b64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
  const url = typeof body.imageUrl === 'string' && /^https:\/\//.test(body.imageUrl) ? body.imageUrl : '';
  if (b64.length > MAX_B64) return { error: true };
  return { image_base64: b64 || undefined, image_url: url || undefined };
}

async function usage(userId, kind) {
  return StudioJob.countDocuments({ user: userId, kind, free: true, status: { $ne: 'failed' }, createdAt: { $gte: dayStart() } });
}

async function submit(req, res, next, kind, payload, meta) {
  try {
    if (!gpu()) return fail(res, 503, 'STUDIO_UNAVAILABLE');
    const userId = req.user._id;
    const mine = await StudioJob.find({ user: userId, kind: { $in: LEGACY_KINDS }, status: { $in: ['queued', 'running'] } }).limit(5);
    for (const j of mine) await refreshJob(j).catch(() => {});
    const active = await StudioJob.countDocuments({ user: userId, kind: { $in: LEGACY_KINDS }, 'meta.film': { $ne: true }, status: { $in: ['queued', 'running'] }, createdAt: { $gte: new Date(Date.now() - 15 * 60e3) } });
    if (active > 0) return fail(res, 429, 'JOB_ACTIVE');
    const usedToday = await usage(userId, kind);
    const { available } = await getAvailableBalance(userId);
    const chars = kind === 'tts' ? charCount(payload.text) : undefined;
    const d = decide({ kind, usedToday, available, promo: promoInfo().active, chars });
    if (!d.ok) return fail(res, d.status, d.code, { price: d.price });

    const path = { fast: '/v1/video/fast', talking: '/v1/video/talking', tts: '/v1/tts', film: '/v1/film' }[kind];
    const r = await gpuFetch(path, { method: 'POST', body: JSON.stringify(payload), timeout: 60000 });
    if (r.status === 429) return fail(res, 429, 'QUEUE_FULL');
    if (r.status === 400) return fail(res, 400, 'BAD_INPUT');
    if (!r.ok) return fail(res, 502, 'STUDIO_UNAVAILABLE');
    const remote = await r.json();

    let tx = null;
    if (d.charge > 0) {
      tx = await WalletTx.create({
        user: userId, type: 'debit', amount: d.charge, status: 'completed',
        note: `AI Studio ${{ fast: 'video nhanh', talking: 'avatar nói', tts: 'giọng nói', film: 'phim AI' }[kind]} (${remote.id.slice(0, 8)})`,
        meta: { channel: 'studio', kind, remoteId: remote.id, ...(chars != null ? { unit: 'characters', quantity: chars } : {}) },
      });
    }
    const small = JSON.stringify(payload).length <= RETRY_MAX_BYTES;
    const job = await StudioJob.create({
      user: userId, kind, remoteId: remote.id, status: remote.status || 'queued', free: d.free, charged: d.charge,
      walletTx: tx?._id || null, retryPayload: small ? payload : null, ...meta,
    });
    res.status(202).json({ id: String(job._id), status: job.status, free: d.free, charged: d.charge, remainingFree: d.remainingFree, position: remote.position, ...(chars != null ? { characters: chars } : {}) });
  } catch (e) {
    if (e.code === 'STUDIO_UNAVAILABLE' || e.name === 'TimeoutError' || e.cause) return fail(res, 503, 'STUDIO_UNAVAILABLE');
    next(e);
  }
}

router.get('/quota', authenticate, async (req, res, next) => {
  try {
    const p = studioPolicy();
    const promo = promoInfo();
    const cap = (k) => (promo.active ? (p[k].promoCap != null ? p[k].promoCap : Math.max(p[k].freePerDay, p.promoPerDay)) : p[k].freePerDay);
    const [fast, talking, tts, bal, av] = await Promise.all([usage(req.user._id, 'fast'), usage(req.user._id, 'talking'), usage(req.user._id, 'tts'), getAvailableBalance(req.user._id), film().availability()]);
    const fp = require('../utils/film-pricing').filmPricing();
    // Real availability (AI service health): 5090 for talking/legacy fast, RunPod for film + fast fallback, serverless TTS.
    const fastViaRunpod = !av.gpu && av.film;
    res.json({
      enabled: Boolean(av.gpu || av.film || av.tts),
      kinds: { fast: Boolean(av.gpu || av.film), talking: av.gpu, tts: av.tts, film: av.film },
      fast: fastViaRunpod
        ? { used: 0, free: 0, price: fp.perSecond * 5, unit: 'video', seconds: 5, imagePrice: fp.perImage, backend: 'aimarkets-gpu' }
        : { used: fast, free: cap('fast'), price: promo.active ? 0 : p.fast.price },
      talking: { used: talking, free: cap('talking'), price: promo.active ? 0 : p.talking.price },
      tts: { used: tts, free: cap('tts'), price: promo.active ? 0 : p.tts.perKChars, unit: 'characters', per: 1000, minCharge: promo.active ? 0 : p.tts.minCharge },
      film: { used: 0, free: 0, price: fp.perSecond, unit: 'second', perSecond: fp.perSecond, perImage: fp.perImage, enabled: av.film },
      available: bal.available,
      promo: promoInfo(),
    });
  } catch (e) { next(e); }
});

router.post('/video/fast', authenticate, (req, res, next) => {
  const b = req.body || {};
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim().slice(0, 1000) : '';
  const img = pickImage(b);
  if (img.error || (!prompt && !img.image_base64 && !img.image_url)) return fail(res, 400, 'BAD_INPUT');
  const seed = Number.isInteger(b.seed) ? b.seed : undefined;
  (async () => {
    const av = await film().availability();
    if (!av.gpu && av.film) {
      // The 5090 is down: one 5 s Wan 2.2 shot on RunPod (per-second price, no free quota).
      if (img.image_url) return fail(res, 400, 'BAD_INPUT');
      const buf = img.image_base64 ? Buffer.from(String(img.image_base64).replace(/^data:[^,]*,/, ''), 'base64') : null;
      if (buf && buf.length > 15 * 1024 ** 2) return fail(res, 400, 'BAD_INPUT');
      return film().fastViaFilm(req, res, { prompt, imageBuffer: buf && buf.length ? buf : null });
    }
    return submit(req, res, next, 'fast', { prompt, ...img, seed }, { prompt });
  })().catch(next);
});

router.post('/video/talking', authenticate, (req, res, next) => {
  const b = req.body || {};
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, 600) : '';
  const lang = voiceLang(b.lang);
  const img = pickImage(b);
  const voice = typeof b.voiceBase64 === 'string' && b.voiceBase64.length < 6_000_000 ? b.voiceBase64 : undefined;
  if (img.error || !text || (!img.image_base64 && !img.image_url)) return fail(res, 400, 'BAD_INPUT');
  return submit(req, res, next, 'talking', { text, lang, ...img, voice_base64: voice, ...voiceFx(b) }, { prompt: text, lang });
});

const clean = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n) : '');

/** AI Film: a scene list rendered by ComfyUI on the 5090 (Flux schnell -> Wan2.2 -> RIFE + VieNeu voice-over). */
router.post('/film', authenticate, (req, res, next) => {
  const b = req.body || {};
  const scenes = (Array.isArray(b.scenes) ? b.scenes : []).slice(0, 6)
    .map((s, i) => ({ prompt: clean(s?.prompt, 600), narration: clean(s?.narration, 400), seed: Number.isInteger(s?.seed) ? s.seed : 100 + i }))
    .filter((s) => s.prompt.length >= 3);
  const lang = voiceLang(b.lang);
  const voice = clean(b.voice, 80) || undefined;
  const title = clean(b.title, 120);
  if (!scenes.length) return fail(res, 400, 'BAD_INPUT');
  return submit(req, res, next, 'film', { title, lang, voice, scenes, ...voiceFx(b) }, { prompt: (title || scenes[0].prompt).slice(0, 1000), lang });
});

/** Speed / pitch / language options (public, cached by the AI service). */
router.get('/voice-options', async (req, res, next) => {
  try {
    if (!gpu()) return fail(res, 503, 'STUDIO_UNAVAILABLE');
    const r = await gpuFetch('/v1/voice-options', { timeout: 10000 });
    if (!r.ok) return fail(res, 502, 'STUDIO_UNAVAILABLE');
    res.set('cache-control', 'public, max-age=300');
    res.json(await r.json());
  } catch (e) {
    if (e.code === 'STUDIO_UNAVAILABLE' || e.name === 'TimeoutError' || e.cause) return fail(res, 503, 'STUDIO_UNAVAILABLE');
    next(e);
  }
});

/** Preset voices. The AI service serves a static catalog (Redis-cached) when the GPU is cold or offline. */
router.get('/voices', authenticate, async (req, res, next) => {
  try {
    if (!gpu()) return fail(res, 503, 'VOICES_UNAVAILABLE');
    const r = await gpuFetch('/v1/voices', { timeout: 15000 });
    if (!r.ok) return fail(res, 502, 'VOICES_UNAVAILABLE');
    res.set('cache-control', 'private, max-age=300');
    res.json(await r.json());
  } catch (e) {
    if (e.code === 'STUDIO_UNAVAILABLE' || e.name === 'TimeoutError' || e.cause) return fail(res, 503, 'VOICES_UNAVAILABLE');
    next(e);
  }
});

router.post('/tts', authenticate, (req, res, next) => {
  const b = req.body || {};
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, 2000) : '';
  const lang = voiceLang(b.lang);
  const voice = typeof b.voice === 'string' ? b.voice.slice(0, 80) : undefined;
  const sample = typeof b.voiceBase64 === 'string' && b.voiceBase64.length < 6_000_000 ? b.voiceBase64 : undefined;
  if (!text) return fail(res, 400, 'BAD_INPUT');
  return submit(req, res, next, 'tts', { text, lang, voice, voice_base64: sample, ...voiceFx(b) }, { prompt: text.slice(0, 1000), lang });
});

async function ownJob(req, res) {
  const job = await StudioJob.findOne({ _id: req.params.id, user: req.user._id }).catch(() => null);
  if (!job) { res.status(404).json({ message: 'Not found' }); return null; }
  return job;
}

async function refundIfNeeded(job) {
  if (job.charged > 0 && !job.refunded) {
    const res = await StudioJob.updateOne({ _id: job._id, refunded: false }, { $set: { refunded: true } });
    if (res.modifiedCount) {
      await WalletTx.create({
        user: job.user, type: 'credit', amount: job.charged, status: 'completed',
        note: `Hoàn phí AI Studio (lỗi ${job.remoteId.slice(0, 8)})`, meta: { channel: 'studio', kind: job.kind, remoteId: job.remoteId, refund: true },
      });
      job.refunded = true;
    }
  }
}


const STALE_MS = Number(process.env.STUDIO_STALE_MIN || 30) * 60e3;

/** Pull the GPU worker state into a queued/running job (also used by the background poller and before the one-active-job check). */
async function refreshJob(job) {
  if (job.status !== 'queued' && job.status !== 'running') return job;
  if (job.kind.startsWith('film-') || (job.meta && job.meta.film)) return film().refreshFilmJob(job);
    const r = await gpuFetch(`/v1/jobs/${job.remoteId}`).catch(() => null);
    if (r && r.status === 404) { job.status = 'failed'; job.error = 'lost'; }
    else if (r && r.ok) {
      const j = await r.json();
      job.status = j.status; job.timings = j.timings || null; job.error = j.error || '';
      if (j.expires_at) job.expiresAt = new Date(j.expires_at * 1000);
      job.$locals.position = j.position;
      job.$locals.progress = j.progress || null;
      job.$locals.stage = j.stage || null;
    }
    if (job.status === 'failed' && job.retries < 1 && job.retryPayload && transient(job.error)) {
      // One automatic resubmit when the worker hiccups; the user keeps polling the same job.
      const path = { fast: '/v1/video/fast', talking: '/v1/video/talking', tts: '/v1/tts', film: '/v1/film' }[job.kind];
      const rr = await gpuFetch(path, { method: 'POST', body: JSON.stringify(job.retryPayload), timeout: 60000 }).catch(() => null);
      if (rr && rr.ok) {
        const again = await rr.json();
        job.retries += 1; job.remoteId = again.id; job.status = again.status || 'queued'; job.$locals.position = again.position;
      }
    }
    if (job.status !== 'queued' && job.status !== 'running') job.retryPayload = null;
    if (job.isModified()) await job.save();
    if (job.status === 'failed') await refundIfNeeded(job);
  if ((job.status === 'queued' || job.status === 'running') && Date.now() - new Date(job.createdAt).getTime() > STALE_MS) {
    job.status = 'failed'; job.error = 'timeout'; job.retryPayload = null;
    await job.save();
    await refundIfNeeded(job);
  }
  return job;
}

let pollTimer = null;
/** Finishes jobs whose browser/app tab closed, so they never block the user with JOB_ACTIVE. STUDIO_POLLER=off disables. */
function startStudioPoller({ tickMs = 15000 } = {}) {
  if (pollTimer || process.env.STUDIO_POLLER === 'off') return;
  const tick = async () => {
    try {
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1 || !gpu()) return;
      const rows = await StudioJob.find({ kind: { $in: LEGACY_KINDS }, 'meta.film': { $ne: true }, status: { $in: ['queued', 'running'] }, updatedAt: { $lt: new Date(Date.now() - 10000) } }).sort({ updatedAt: 1 }).limit(25);
      for (const j of rows) await refreshJob(j).catch((e) => console.error('[studio] refresh', String(j._id), e.message));
      await film().pollFilmJobs().catch((e) => console.error('[film] poller', e.message));
    } catch (e) { console.error('[studio] poller', e.message); }
  };
  pollTimer = setInterval(tick, tickMs);
  pollTimer.unref?.();
}

router.get('/jobs', authenticate, async (req, res, next) => {
  try {
    const rows = await StudioJob.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({ items: rows.map((j) => ({ id: String(j._id), kind: j.kind, status: j.status, prompt: j.prompt, charged: j.charged, free: j.free, createdAt: j.createdAt, expiresAt: j.expiresAt })) });
  } catch (e) { next(e); }
});

router.get('/jobs/:id', authenticate, async (req, res, next) => {
  try {
    const job = await ownJob(req, res);
    if (!job) return;
    await refreshJob(job);
    const ok = job.status === 'succeeded' && (!job.expiresAt || job.expiresAt > new Date());
    res.json({
      id: String(job._id), kind: job.kind, status: job.status, position: job.$locals.position ?? null,
      progress: job.$locals.progress ?? null, stage: job.$locals.stage ?? null, timings: job.timings, error: job.status === 'failed' ? failMessage(job.kind, job.error, job.refunded) : '',
      charged: job.charged, free: job.free, refunded: job.refunded, expiresAt: job.expiresAt,
      videoUrl: ok && job.kind !== 'tts' ? `/v1/studio/jobs/${job._id}/video` : null,
      audioUrl: ok && job.kind === 'tts' ? `/v1/studio/jobs/${job._id}/audio` : null,
      imageUrl: ok && (job.kind === 'fast' || job.kind === 'film') ? `/v1/studio/jobs/${job._id}/image` : null,
    });
  } catch (e) { next(e); }
});

async function stream(req, res, next, ext) {
  try {
    const job = await ownJob(req, res);
    if (!job) return;
    if (job.status !== 'succeeded') return res.status(409).json({ message: 'Not ready' });
    if (job.meta && job.meta.film) return film().streamFilmFile(job, res, ext);
    const r = await gpuFetch(`/v1/files/${job.remoteId}.${ext}`, { timeout: 120000 });
    if (!r.ok) return res.status(410).json({ message: 'File đã hết hạn' });
    res.set('content-type', { mp4: 'video/mp4', wav: 'audio/wav', jpg: 'image/jpeg' }[ext]);
    res.set('cache-control', 'private, max-age=600');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { next(e); }
}
router.get('/jobs/:id/video', authenticate, (req, res, next) => stream(req, res, next, 'mp4'));
router.get('/jobs/:id/audio', authenticate, (req, res, next) => stream(req, res, next, 'wav'));
router.get('/jobs/:id/image', authenticate, (req, res, next) => stream(req, res, next, 'jpg'));

module.exports = router;
module.exports.startStudioPoller = startStudioPoller;
module.exports.refreshJob = refreshJob;


