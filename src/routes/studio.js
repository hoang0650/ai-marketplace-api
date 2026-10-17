const express = require('express');
const { authenticate } = require('../middleware/auth');
const StudioJob = require('../models/StudioJob');
const WalletTx = require('../models/WalletTx');
const { getAvailableBalance } = require('../utils/wallet');
const { studioPolicy, dayStart, decide } = require('../utils/studio-policy');

const router = express.Router();
const MAX_B64 = 11_000_000;

const { gpuConfig, gpuFetch, promoInfo } = require('../utils/aimx-gpu');
const { failMessage, transient } = require('../utils/studio-errors');

const RETRY_MAX_BYTES = 200_000; // retry small jobs (text-only TTS) once on transient worker errors

const gpu = () => (gpuConfig().enabled ? gpuConfig() : null);

const MESSAGES = {
  STUDIO_UNAVAILABLE: 'Máy GPU tạm thời không khả dụng, vui lòng thử lại sau.',
  INSUFFICIENT_WALLET: 'Bạn đã dùng hết lượt miễn phí hôm nay. Số dư ví không đủ để tạo thêm.',
  FREE_QUOTA_EXHAUSTED: 'Bạn đã dùng hết lượt miễn phí hôm nay.',
  JOB_ACTIVE: 'Bạn đang có một video đang tạo. Vui lòng đợi hoàn tất.',
  QUEUE_FULL: 'Hàng đợi GPU đang đầy, vui lòng thử lại sau ít phút.',
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
    const active = await StudioJob.countDocuments({ user: userId, status: { $in: ['queued', 'running'] }, createdAt: { $gte: new Date(Date.now() - 15 * 60e3) } });
    if (active > 0) return fail(res, 429, 'JOB_ACTIVE');
    const usedToday = await usage(userId, kind);
    const { available } = await getAvailableBalance(userId);
    const d = decide({ kind, usedToday, available, promo: promoInfo().active });
    if (!d.ok) return fail(res, d.status, d.code, { price: d.price });

    const path = { fast: '/v1/video/fast', talking: '/v1/video/talking', tts: '/v1/tts' }[kind];
    const r = await gpuFetch(path, { method: 'POST', body: JSON.stringify(payload), timeout: 60000 });
    if (r.status === 429) return fail(res, 429, 'QUEUE_FULL');
    if (!r.ok) return fail(res, 502, 'STUDIO_UNAVAILABLE');
    const remote = await r.json();

    let tx = null;
    if (d.charge > 0) {
      tx = await WalletTx.create({
        user: userId, type: 'debit', amount: d.charge, status: 'completed',
        note: `AI Studio ${{ fast: 'video nhanh', talking: 'avatar nói', tts: 'giọng nói' }[kind]} (${remote.id.slice(0, 8)})`,
        meta: { channel: 'studio', kind, remoteId: remote.id },
      });
    }
    const small = JSON.stringify(payload).length <= RETRY_MAX_BYTES;
    const job = await StudioJob.create({
      user: userId, kind, remoteId: remote.id, status: remote.status || 'queued', free: d.free, charged: d.charge,
      walletTx: tx?._id || null, retryPayload: small ? payload : null, ...meta,
    });
    res.status(202).json({ id: String(job._id), status: job.status, free: d.free, charged: d.charge, remainingFree: d.remainingFree, position: remote.position });
  } catch (e) {
    if (e.code === 'STUDIO_UNAVAILABLE' || e.name === 'TimeoutError' || e.cause) return fail(res, 503, 'STUDIO_UNAVAILABLE');
    next(e);
  }
}

router.get('/quota', authenticate, async (req, res, next) => {
  try {
    const p = studioPolicy();
    const promo = promoInfo();
    const cap = (k) => (promo.active ? Math.max(p[k].freePerDay, p.promoPerDay) : p[k].freePerDay);
    const [fast, talking, tts, bal] = await Promise.all([usage(req.user._id, 'fast'), usage(req.user._id, 'talking'), usage(req.user._id, 'tts'), getAvailableBalance(req.user._id)]);
    res.json({
      enabled: Boolean(gpu()),
      fast: { used: fast, free: cap('fast'), price: promo.active ? 0 : p.fast.price },
      talking: { used: talking, free: cap('talking'), price: promo.active ? 0 : p.talking.price },
      tts: { used: tts, free: cap('tts'), price: promo.active ? 0 : p.tts.price },
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
  return submit(req, res, next, 'fast', { prompt, ...img, seed }, { prompt });
});

router.post('/video/talking', authenticate, (req, res, next) => {
  const b = req.body || {};
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, 600) : '';
  const lang = ['vi', 'en', 'zh'].includes(b.lang) ? b.lang : 'vi';
  const img = pickImage(b);
  const voice = typeof b.voiceBase64 === 'string' && b.voiceBase64.length < 6_000_000 ? b.voiceBase64 : undefined;
  if (img.error || !text || (!img.image_base64 && !img.image_url)) return fail(res, 400, 'BAD_INPUT');
  return submit(req, res, next, 'talking', { text, lang, ...img, voice_base64: voice }, { prompt: text, lang });
});

router.get('/voices', authenticate, async (req, res, next) => {
  try {
    if (!gpu()) return fail(res, 503, 'STUDIO_UNAVAILABLE');
    const r = await gpuFetch('/v1/voices');
    if (!r.ok) return fail(res, 502, 'STUDIO_UNAVAILABLE');
    res.json(await r.json());
  } catch (e) {
    if (e.code === 'STUDIO_UNAVAILABLE' || e.name === 'TimeoutError' || e.cause) return fail(res, 503, 'STUDIO_UNAVAILABLE');
    next(e);
  }
});

router.post('/tts', authenticate, (req, res, next) => {
  const b = req.body || {};
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, 2000) : '';
  const lang = ['vi', 'en', 'zh'].includes(b.lang) ? b.lang : 'vi';
  const voice = typeof b.voice === 'string' ? b.voice.slice(0, 80) : undefined;
  const sample = typeof b.voiceBase64 === 'string' && b.voiceBase64.length < 6_000_000 ? b.voiceBase64 : undefined;
  if (!text) return fail(res, 400, 'BAD_INPUT');
  return submit(req, res, next, 'tts', { text, lang, voice, voice_base64: sample }, { prompt: text.slice(0, 1000), lang });
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
    if (job.status === 'queued' || job.status === 'running') {
      const r = await gpuFetch(`/v1/jobs/${job.remoteId}`).catch(() => null);
      if (r && r.status === 404) { job.status = 'failed'; job.error = 'lost'; }
      else if (r && r.ok) {
        const j = await r.json();
        job.status = j.status; job.timings = j.timings || null; job.error = j.error || '';
        if (j.expires_at) job.expiresAt = new Date(j.expires_at * 1000);
        job.$locals.position = j.position;
      }
      if (job.status === 'failed' && job.retries < 1 && job.retryPayload && transient(job.error)) {
        // One automatic resubmit when the worker hiccups; the user keeps polling the same job.
        const path = { fast: '/v1/video/fast', talking: '/v1/video/talking', tts: '/v1/tts' }[job.kind];
        const rr = await gpuFetch(path, { method: 'POST', body: JSON.stringify(job.retryPayload), timeout: 60000 }).catch(() => null);
        if (rr && rr.ok) {
          const again = await rr.json();
          job.retries += 1; job.remoteId = again.id; job.status = again.status || 'queued'; job.$locals.position = again.position;
        }
      }
      if (job.status !== 'queued' && job.status !== 'running') job.retryPayload = null;
      if (job.isModified()) await job.save();
      if (job.status === 'failed') await refundIfNeeded(job);
    }
    const ok = job.status === 'succeeded' && (!job.expiresAt || job.expiresAt > new Date());
    res.json({
      id: String(job._id), kind: job.kind, status: job.status, position: job.$locals.position ?? null,
      timings: job.timings, error: job.status === 'failed' ? failMessage(job.kind, job.error, job.refunded) : '',
      charged: job.charged, free: job.free, refunded: job.refunded, expiresAt: job.expiresAt,
      videoUrl: ok && job.kind !== 'tts' ? `/v1/studio/jobs/${job._id}/video` : null,
      audioUrl: ok && job.kind === 'tts' ? `/v1/studio/jobs/${job._id}/audio` : null,
      imageUrl: ok && job.kind === 'fast' ? `/v1/studio/jobs/${job._id}/image` : null,
    });
  } catch (e) { next(e); }
});

async function stream(req, res, next, ext) {
  try {
    const job = await ownJob(req, res);
    if (!job) return;
    if (job.status !== 'succeeded') return res.status(409).json({ message: 'Not ready' });
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


