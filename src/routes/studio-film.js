/**
 * AI Film v2: server-side projects (≤120 min), 5–60 s scenes made of chained Wan 2.2 I2V 720p shots,
 * Qwen-Image-Edit-2511 first frames, uploads/music in MinIO and a final ffmpeg join — all GPU/AI work runs
 * in ai-marketplace-ai (/providers/aimx/film/*) on RunPod public endpoints. This API only keeps user data,
 * presigns private MinIO URLs and bills: per generated second and per image, debited atomically under the
 * wallet lock before submit, and failed shots/images refunded when the job settles. No free daily quota.
 */
const express = require('express');
const crypto = require('crypto');
const { authenticate } = require('../middleware/auth');
const StudioJob = require('../models/StudioJob');
const WalletTx = require('../models/WalletTx');
const FilmProject = require('../models/FilmProject');
const { getSpendableBalance } = require('../utils/wallet');
const { withWalletLock } = require('../utils/wallet-lock');
const { gpuConfig, gpuFetch } = require('../utils/aimx-gpu');
const { studioPolicy } = require('../utils/studio-policy');
const { voiceLang } = require('../utils/voice-params');
const fp = require('../utils/film-pricing');
const minio = require('../config/minio');

const router = express.Router();
const MAX_PROJECTS = Number(process.env.FILM_MAX_PROJECTS || 30);
const MAX_ACTIVE = Number(process.env.FILM_MAX_ACTIVE_JOBS || 3);
const MAX_VERSIONS = 10;
const STALE_MS = 3 * 3600e3;
const SIGN_TTL = 6 * 3600;
const UPLOAD_LIMITS = { video: 2 * 1024 ** 3, image: 15 * 1024 ** 2, audio: 300 * 1024 ** 2 };
const CAMERAS = ['static', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'orbit', 'tilt-up', 'handheld', 'aerial'];
const FILM_KINDS = ['film-scene', 'film-image', 'film-render'];

const MESSAGES = {
  STUDIO_UNAVAILABLE: 'Dịch vụ làm phim AI tạm thời không khả dụng, vui lòng thử lại sau.',
  INSUFFICIENT_WALLET: 'Số dư ví không đủ cho lượt tạo này.',
  PRICE_REQUIRED: 'Vui lòng xem giá ước tính trước khi tạo.',
  PRICE_CHANGED: 'Giá ước tính đã thay đổi, vui lòng xác nhận lại.',
  JOB_ACTIVE: 'Bạn đang có quá nhiều cảnh đang tạo. Vui lòng đợi.',
  BUSY: 'Cảnh này đang được tạo.',
  NOT_READY: 'Một số cảnh chưa sẵn sàng để xuất phim.',
  TOO_LONG: 'Phim vượt quá 120 phút.',
  BAD_INPUT: 'Dữ liệu không hợp lệ.',
  NOT_FOUND: 'Không tìm thấy.',
  LIMIT: 'Đã đạt giới hạn.',
};
function fail(res, status, code, extra = {}) {
  return res.status(status).json({ code, message: MESSAGES[code] || code, ...extra });
}
const clean = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n) : '');
const newSid = () => crypto.randomBytes(5).toString('hex');
const seedOf = () => crypto.randomInt(1, 2 ** 31 - 1);

/* ------------------------------------------------------------- availability -- */
let avail = { at: 0, v: null };
/** Real availability from the AI service health (5090 reachability, RunPod film endpoints, serverless TTS). */
async function availability({ fresh = false } = {}) {
  if (!gpuConfig().enabled) return { ai: false, gpu: false, film: false, tts: false };
  if (!fresh && avail.v && Date.now() - avail.at < 30000) return avail.v;
  let v = { ai: false, gpu: false, film: false, tts: false };
  try {
    const r = await gpuFetch('/health', { timeout: 15000 });
    if (r.ok) {
      const h = await r.json();
      const sls = Boolean(h.serverless && h.serverless.ok);
      v = { ai: true, gpu: Boolean(h.ok), film: Boolean(h.film && h.film.ok) && minio.isMinioEnabled(), tts: Boolean(h.ok) || sls };
    }
  } catch { /* unreachable -> all false */ }
  avail = { at: Date.now(), v };
  return v;
}
availability._reset = () => { avail = { at: 0, v: null }; };

/* ------------------------------------------------------------------ wallet -- */
/** Balance check + debit under the per-user wallet lock (no double spend across parallel requests). */
async function debit(userId, amount, note, meta) {
  return withWalletLock(userId, async () => {
    const bal = await getSpendableBalance(userId);
    if (bal + 1e-9 < amount) {
      const e = new Error('insufficient'); e.code = 'INSUFFICIENT_WALLET'; e.status = 402; e.available = bal;
      throw e;
    }
    return WalletTx.create({ user: userId, type: 'debit', amount: fp.round6(amount), status: 'completed', note, meta: { channel: 'studio', ...meta } });
  });
}
async function credit(userId, amount, note, meta) {
  const a = fp.round6(amount);
  if (!(a > 0)) return null;
  return WalletTx.create({ user: userId, type: 'credit', amount: a, status: 'completed', note, meta: { channel: 'studio', refund: true, ...meta } });
}

/* ---------------------------------------------------------------- projects -- */
const key = (p, ...parts) => minio.filmObjectName(p.user, String(p._id), ...parts);
const sign = (k) => (k ? minio.presignFilmGet(k, SIGN_TTL) : null);
const putUrl = (k) => minio.presignFilmPut(k, SIGN_TTL);

function planShots(scene) {
  const old = scene.shots || [];
  return fp.splitDuration(scene.duration).map((d, i) => {
    const o = old[i];
    if (o && o.duration === d) return o;
    return { sid: o ? o.sid : newSid(), prompt: o ? o.prompt : '', duration: d, seed: -1, status: 'draft', error: '', active: -1, versions: o && o.duration === d ? o.versions : [] };
  });
}

function sceneSeconds(p, s) {
  if (s.source === 'upload') {
    const u = (p.uploads || []).find((x) => x.uid === s.uploadId);
    return u ? Math.round(u.duration || 0) : 0;
  }
  const done = (s.shots || []).every((sh) => sh.active >= 0);
  return done && s.shots.length ? s.shots.reduce((a, sh) => a + sh.duration, 0) : fp.splitDuration(s.duration).reduce((a, b) => a + b, 0);
}
const projectSeconds = (p) => (p.scenes || []).reduce((a, s) => a + sceneSeconds(p, s), 0);

function sceneIn(raw, prev) {
  const s = prev ? (typeof prev.toObject === 'function' ? prev.toObject() : { ...prev }) : { sid: newSid(), shots: [], keyframes: [], status: 'draft', generation: 0 };
  if (raw.title !== undefined) s.title = clean(raw.title, 120);
  if (raw.prompt !== undefined) s.prompt = clean(raw.prompt, 600);
  if (raw.narration !== undefined) s.narration = clean(raw.narration, 1500);
  if (raw.voice !== undefined) s.voice = clean(raw.voice, 80) || 'Binh';
  if (raw.camera !== undefined) s.camera = CAMERAS.includes(raw.camera) ? raw.camera : 'push-in';
  if (raw.transition !== undefined) s.transition = clean(raw.transition, 20) || 'cut';
  if (raw.source !== undefined) s.source = raw.source === 'upload' ? 'upload' : 'ai';
  if (raw.uploadId !== undefined) s.uploadId = clean(raw.uploadId, 40);
  if (raw.startUploadId !== undefined) s.startUploadId = clean(raw.startUploadId, 40);
  if (raw.chainPrev !== undefined) s.chainPrev = Boolean(raw.chainPrev);
  if (Array.isArray(raw.characterIds)) s.characterIds = raw.characterIds.filter((x) => /^[a-f0-9]{24}$/.test(String(x))).slice(0, 3);
  if (raw.settingId !== undefined) s.settingId = /^[a-f0-9]{24}$/.test(String(raw.settingId || '')) ? raw.settingId : null;
  const busy = s.status === 'generating';
  if (raw.duration !== undefined && !busy) {
    const d = Math.max(5, Math.min(fp.SCENE_MAX_SEC, Math.round(Number(raw.duration) / 5) * 5 || 5));
    if (d !== s.duration || !s.shots.length) {
      s.duration = d;
      const generated = s.shots.some((sh) => sh.versions && sh.versions.length);
      const same = fp.splitDuration(d).join() === s.shots.map((x) => x.duration).join();
      if (!generated) s.shots = planShots(s);
      else if (!same) s.status = 'stale';
    }
  }
  if (!s.shots.length && s.source !== 'upload') s.shots = planShots({ ...s, duration: s.duration || 15 });
  if (Array.isArray(raw.shots)) {
    raw.shots.forEach((r, i) => {
      const sh = s.shots.find((x) => r && x.sid === r.sid) || s.shots[i];
      if (sh && r && r.prompt !== undefined) sh.prompt = clean(r.prompt, 400);
    });
  }
  return s;
}

async function view(p, { sign: doSign = true } = {}) {
  const o = typeof p.toObject === 'function' ? p.toObject() : p;
  const media = {};
  const add = async (k) => { if (k && doSign && !media[k]) media[k] = await sign(k); };
  for (const s of o.scenes || []) {
    for (const sh of s.shots || []) {
      const v = sh.versions[sh.active];
      if (v) { await add(v.videoKey); await add(v.frameKey); }
    }
    const kf = s.keyframes[s.keyframes.length - 1];
    if (kf) await add(kf.frameKey);
  }
  for (const u of o.uploads || []) if (u.status === 'ready') await add(u.key);
  for (const r of (o.renders || []).slice(-5)) if (r.status === 'succeeded') await add(r.key);
  return { ...o, id: String(o._id), totalSeconds: projectSeconds(o), maxSeconds: fp.PROJECT_MAX_SEC, media };
}

async function ownProject(req, res) {
  const p = await FilmProject.findOne({ _id: req.params.id, user: req.user._id }).catch(() => null);
  if (!p) { fail(res, 404, 'NOT_FOUND'); return null; }
  return p;
}

/** Re-read + re-apply on concurrent edits (optimistic concurrency on __v). */
async function mutate(projectId, fn, tries = 4) {
  for (let i = 0; ; i += 1) {
    const p = await FilmProject.findById(projectId);
    if (!p) return null;
    const out = await fn(p);
    if (out === false) return p;
    try { await p.save(); return p; } catch (e) {
      if (e.name !== 'VersionError' || i >= tries) throw e;
    }
  }
}

/* --------------------------------------------------------------- estimate -- */
function scenePlan(p, s, idx) {
  const shots = fp.splitDuration(s.duration);
  const prev = idx > 0 ? p.scenes[idx - 1] : null;
  const prevFrame = prev && prev.shots && prev.shots.length ? (prev.shots[prev.shots.length - 1].versions || [])[prev.shots[prev.shots.length - 1].active] : null;
  const startUpload = s.startUploadId ? (p.uploads || []).find((u) => u.uid === s.startUploadId && u.kind === 'image' && u.status === 'ready') : null;
  const refs = (s.characterIds || []).length || s.settingId;
  let start = null;
  if (!refs && s.chainPrev && prevFrame && prevFrame.frameKey) start = { key: prevFrame.frameKey, from: 'prev' };
  else if (!refs && startUpload) start = { key: startUpload.key, from: 'upload' };
  const images = start ? 0 : 1;
  const seconds = shots.reduce((a, b) => a + b, 0);
  return { sid: s.sid, shots, seconds, images, start, price: fp.filmCharge({ seconds, images }) };
}

function renderPlan(p) {
  const pol = studioPolicy().tts;
  const chars = (p.scenes || []).reduce((a, s) => a + (s.narration ? [...s.narration].length : 0), 0);
  const price = chars ? fp.round6(Math.max(pol.minCharge || 0, (chars / 1000) * pol.perKChars)) : 0;
  return { chars, price };
}

/* ------------------------------------------------------------------ routes -- */
router.get('/config', authenticate, async (req, res, next) => {
  try {
    const a = await availability();
    const pr = fp.filmPricing();
    res.json({
      available: a.film, perSecond: pr.perSecond, perImage: pr.perImage, ttsPerK: studioPolicy().tts.perKChars,
      durations: fp.WAN_DURATIONS, sceneMaxSec: fp.SCENE_MAX_SEC, projectMaxSec: fp.PROJECT_MAX_SEC, freePerDay: 0,
      cameras: CAMERAS, models: { video: 'Wan 2.2 I2V 720p', image: 'Qwen-Image-Edit-2511' },
    });
  } catch (e) { next(e); }
});

router.get('/projects', authenticate, async (req, res, next) => {
  try {
    const rows = await FilmProject.find({ user: req.user._id }).sort({ updatedAt: -1 }).limit(MAX_PROJECTS).lean();
    res.json({ items: rows.map((p) => ({ id: String(p._id), title: p.title, scenes: p.scenes.length, totalSeconds: projectSeconds(p), updatedAt: p.updatedAt })) });
  } catch (e) { next(e); }
});

router.post('/projects', authenticate, async (req, res, next) => {
  try {
    const n = await FilmProject.countDocuments({ user: req.user._id });
    if (n >= MAX_PROJECTS) return fail(res, 409, 'LIMIT');
    const b = req.body || {};
    const scenes = (Array.isArray(b.scenes) ? b.scenes : []).slice(0, 1440).map((s) => sceneIn({ ...s, source: 'ai' }, null));
    const p = new FilmProject({ user: req.user._id, title: clean(b.title, 120) || 'Phim AI', lang: voiceLang(b.lang), scenes });
    if (projectSeconds(p) > fp.PROJECT_MAX_SEC) return fail(res, 400, 'TOO_LONG');
    await p.save();
    res.status(201).json(await view(p));
  } catch (e) { next(e); }
});

router.get('/projects/:id', authenticate, async (req, res, next) => {
  try {
    const p = await ownProject(req, res);
    if (!p) return;
    const active = await StudioJob.find({ project: p._id, status: { $in: ['queued', 'running'] } }).limit(20);
    for (const j of active) await refreshFilmJob(j).catch(() => {});
    const fresh = active.length ? await FilmProject.findById(p._id) : p;
    res.json(await view(fresh));
  } catch (e) { next(e); }
});

router.put('/projects/:id', authenticate, async (req, res, next) => {
  try {
    const p0 = await ownProject(req, res);
    if (!p0) return;
    const b = req.body || {};
    let err = null;
    let removed = [];
    const p = await mutate(p0._id, (p) => {
      if (b.title !== undefined) p.title = clean(b.title, 120) || 'Phim AI';
      if (b.lang !== undefined) p.lang = voiceLang(b.lang);
      if (b.music && typeof b.music === 'object') {
        if (b.music.uploadId !== undefined) p.music.uploadId = (p.uploads || []).some((u) => u.uid === b.music.uploadId && u.kind === 'audio') ? b.music.uploadId : '';
        if (b.music.volume !== undefined) p.music.volume = Math.max(0, Math.min(1, Number(b.music.volume) || 0));
      }
      if (Array.isArray(b.scenes)) {
        if (b.scenes.length > 1440) { err = 'LIMIT'; return false; }
        const bySid = new Map(p.scenes.map((s) => [s.sid, s]));
        const next = b.scenes.map((raw) => sceneIn(raw || {}, raw && bySid.get(raw.sid)));
        const keep = new Set(next.map((s) => s.sid));
        const dropping = p.scenes.filter((s) => !keep.has(s.sid));
        if (dropping.some((s) => s.status === 'generating')) { err = 'BUSY'; return false; }
        removed = dropping.map((s) => s.sid);
        for (const s of next) {
          if (s.source === 'upload' && !(p.uploads || []).some((u) => u.uid === s.uploadId && u.kind === 'video' && u.status === 'ready')) { err = 'BAD_INPUT'; return false; }
        }
        p.scenes = next;
        if (projectSeconds(p) > fp.PROJECT_MAX_SEC) { err = 'TOO_LONG'; return false; }
      }
      return true;
    });
    if (err) return fail(res, err === 'BUSY' ? 409 : 400, err);
    for (const sid of removed) minio.removeFilmPrefix(key(p, 'scenes', sid)).catch(() => {});
    res.json(await view(p));
  } catch (e) { next(e); }
});

router.delete('/projects/:id', authenticate, async (req, res, next) => {
  try {
    const p = await ownProject(req, res);
    if (!p) return;
    const busy = await StudioJob.countDocuments({ project: p._id, status: { $in: ['queued', 'running'] } });
    if (busy) return fail(res, 409, 'BUSY');
    await minio.removeFilmPrefix(minio.filmObjectName(p.user, String(p._id))).catch(() => 0);
    await FilmProject.deleteOne({ _id: p._id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Owner-checked short-lived link for any file of the project (version history, downloads). */
router.get('/projects/:id/media', authenticate, async (req, res, next) => {
  try {
    const p = await ownProject(req, res);
    if (!p) return;
    const k = String(req.query.key || '');
    if (!minio.isFilmObjectFor(k, p.user, String(p._id))) return fail(res, 400, 'BAD_INPUT');
    res.json({ url: await sign(k) });
  } catch (e) { next(e); }
});

/* ----------------------------------------------------------------- uploads -- */
router.post('/projects/:id/uploads', authenticate, async (req, res, next) => {
  try {
    const p0 = await ownProject(req, res);
    if (!p0) return;
    const b = req.body || {};
    const kind = ['video', 'image', 'audio'].includes(b.kind) ? b.kind : null;
    const size = Number(b.size) || 0;
    const ct = clean(b.contentType, 80).toLowerCase();
    if (!kind || size <= 0 || size > UPLOAD_LIMITS[kind] || !ct.startsWith(`${kind}/`)) return fail(res, 400, 'BAD_INPUT', { maxBytes: kind ? UPLOAD_LIMITS[kind] : undefined });
    if ((p0.uploads || []).length >= 300) return fail(res, 409, 'LIMIT');
    const ext = (clean(b.name, 160).match(/\.([a-z0-9]{2,5})$/i) || [, { video: 'mp4', image: 'jpg', audio: 'mp3' }[kind]])[1].toLowerCase();
    const uid = newSid();
    const k = key(p0, 'uploads', `${uid}.${ext}`);
    const p = await mutate(p0._id, (p) => { p.uploads.push({ uid, kind, name: clean(b.name, 160), key: k, size, contentType: ct, status: 'pending' }); });
    res.status(201).json({ upload: p.uploads.find((u) => u.uid === uid), putUrl: await putUrl(k), headers: { 'content-type': ct } });
  } catch (e) { next(e); }
});

router.post('/projects/:id/uploads/:uid/confirm', authenticate, async (req, res, next) => {
  try {
    const p0 = await ownProject(req, res);
    if (!p0) return;
    const u0 = (p0.uploads || []).find((u) => u.uid === req.params.uid);
    if (!u0) return fail(res, 404, 'NOT_FOUND');
    const st = await minio.statFilmObject(u0.key).catch(() => null);
    if (!st || !st.size || st.size > UPLOAD_LIMITS[u0.kind]) return fail(res, 400, 'BAD_INPUT', { reason: 'upload missing' });
    let duration = 0;
    if (u0.kind !== 'image') {
      const r = await gpuFetch('/film/probe', { method: 'POST', body: JSON.stringify({ get: await sign(u0.key) }), timeout: 120000 }).catch(() => null);
      const info = r && r.ok ? await r.json() : null;
      if (!info || (u0.kind === 'video' && !info.video) || (u0.kind === 'audio' && !info.audio)) return fail(res, 400, 'BAD_INPUT', { reason: 'unreadable media' });
      duration = Math.round((Number(info.duration) || 0) * 100) / 100;
      if (u0.kind === 'video' && (duration <= 0 || duration > fp.PROJECT_MAX_SEC)) return fail(res, 400, 'BAD_INPUT', { reason: 'duration' });
    }
    const p = await mutate(p0._id, (p) => {
      const u = p.uploads.find((x) => x.uid === req.params.uid);
      if (!u) return false;
      u.size = st.size; u.duration = duration; u.status = 'ready';
      return true;
    });
    res.json({ upload: p.uploads.find((u) => u.uid === req.params.uid), url: await sign(u0.key) });
  } catch (e) { next(e); }
});

router.delete('/projects/:id/uploads/:uid', authenticate, async (req, res, next) => {
  try {
    const p0 = await ownProject(req, res);
    if (!p0) return;
    let k = '';
    let used = false;
    await mutate(p0._id, (p) => {
      const u = p.uploads.find((x) => x.uid === req.params.uid);
      if (!u) return false;
      used = p.scenes.some((s) => s.uploadId === u.uid || s.startUploadId === u.uid) || p.music.uploadId === u.uid;
      if (used) return false;
      k = u.key;
      p.uploads = p.uploads.filter((x) => x.uid !== u.uid);
      return true;
    });
    if (used) return fail(res, 409, 'BUSY');
    if (k) minio.removeFilmPrefix(k).catch(() => {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- estimate -- */
router.post('/projects/:id/estimate', authenticate, async (req, res, next) => {
  try {
    const p = await ownProject(req, res);
    if (!p) return;
    const b = req.body || {};
    const want = Array.isArray(b.sceneIds) ? new Set(b.sceneIds.map(String)) : null;
    const items = p.scenes.map((s, i) => [s, i])
      .filter(([s]) => s.source === 'ai' && (want ? want.has(s.sid) : !['ready', 'generating'].includes(s.status)))
      .map(([s, i]) => { const pl = scenePlan(p, s, i); return { sid: s.sid, shots: pl.shots, seconds: pl.seconds, images: pl.images, price: pl.price }; });
    const rp = renderPlan(p);
    const pr = fp.filmPricing();
    res.json({
      items, perSecond: pr.perSecond, perImage: pr.perImage,
      total: fp.round6(items.reduce((a, x) => a + x.price, 0)),
      render: { ttsChars: rp.chars, price: rp.price },
      available: await getSpendableBalance(req.user._id),
    });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- generate -- */
async function checkActive(userId) {
  const mine = await StudioJob.find({ user: userId, kind: { $in: FILM_KINDS }, status: { $in: ['queued', 'running'] } }).limit(10);
  for (const j of mine) await refreshFilmJob(j).catch(() => {});
  return mine.filter((j) => j.status === 'queued' || j.status === 'running').length;
}

async function submitAi(path, body) {
  const r = await gpuFetch(path, { method: 'POST', body: JSON.stringify(body), timeout: 60000 }).catch(() => null);
  if (!r) return { error: 'STUDIO_UNAVAILABLE', status: 503 };
  if (r.status === 400) return { error: 'BAD_INPUT', status: 400 };
  if (!r.ok) return { error: 'STUDIO_UNAVAILABLE', status: r.status === 503 ? 503 : 502 };
  return { remote: await r.json() };
}

/**
 * Debit (atomic) -> submit to the AI service -> record the job. If the submit fails the debit is credited back at once.
 * `charge` = { amount, note, meta }.
 */
async function billAndSubmit(req, { charge, path, body, job }) {
  const userId = req.user._id;
  let tx = null;
  if (charge.amount > 0) tx = await debit(userId, charge.amount, charge.note, charge.meta);
  const out = await submitAi(path, body).catch(() => ({ error: 'STUDIO_UNAVAILABLE', status: 503 }));
  if (out.error) {
    if (tx) await credit(userId, charge.amount, `Hoàn phí ${charge.note} (không gửi được)`, { kind: charge.meta.kind, submitFailed: true });
    return out;
  }
  const row = await StudioJob.create({ user: userId, remoteId: out.remote.id, status: 'queued', charged: charge.amount, free: false, walletTx: tx ? tx._id : null, ...job });
  if (tx) WalletTx.updateOne({ _id: tx._id }, { $set: { 'meta.remoteId': out.remote.id, 'meta.job': String(row._id) } }).catch(() => {});
  return { job: row };
}

function priceGate(req, res, price) {
  const exp = req.body && req.body.expectedPrice;
  if (price > 0 && (exp === undefined || exp === null || !Number.isFinite(Number(exp)))) { fail(res, 400, 'PRICE_REQUIRED', { price }); return false; }
  if (price > 0 && Math.abs(Number(exp) - price) > 1e-6) { fail(res, 409, 'PRICE_CHANGED', { price }); return false; }
  return true;
}

/** Generate (or regenerate) one AI scene: keyframe/start frame + chained shots. */
router.post('/projects/:id/scenes/:sid/generate', authenticate, async (req, res, next) => {
  try {
    const p = await ownProject(req, res);
    if (!p) return;
    if (!(await availability()).film) return fail(res, 503, 'STUDIO_UNAVAILABLE');
    const idx = p.scenes.findIndex((s) => s.sid === req.params.sid);
    const scene = p.scenes[idx];
    if (!scene || scene.source !== 'ai') return fail(res, 404, 'NOT_FOUND');
    if (scene.status === 'generating') return fail(res, 409, 'BUSY');
    if ((scene.prompt || '').length < 3) return fail(res, 400, 'BAD_INPUT', { reason: 'prompt' });
    const plan = scenePlan(p, scene, idx);
    if (!priceGate(req, res, plan.price)) return;
    if ((await checkActive(req.user._id)) >= MAX_ACTIVE) return fail(res, 429, 'JOB_ACTIVE');
    // Claim the scene atomically so two clicks can never bill/submit it twice.
    const prevStatus = scene.status;
    const claim = await FilmProject.updateOne({ _id: p._id, scenes: { $elemMatch: { sid: scene.sid, status: { $ne: 'generating' } } } }, { $set: { 'scenes.$.status': 'generating' } });
    if (!claim.modifiedCount) return fail(res, 409, 'BUSY');
    const unclaim = () => FilmProject.updateOne({ _id: p._id, 'scenes.sid': scene.sid }, { $set: { 'scenes.$.status': prevStatus } }).catch(() => {});
    let out;
    let shots;
    try {
    const gen = (scene.generation || 0) + 1;
    shots = planShots({ ...scene.toObject(), duration: plan.seconds });
    const base = (n) => key(p, 'scenes', scene.sid, n);
    const kfKey = plan.start ? '' : base(`key-g${gen}.jpg`);
    const startKey = plan.start ? base(`start-g${gen}.jpg`) : '';
    const spec = {
      scene: { prompt: scene.prompt, camera: scene.camera },
      keyframe: plan.start ? null : { mode: 'keyframe', prompt: scene.prompt, images: [], put: await putUrl(kfKey), get: await sign(kfKey), seed: seedOf() },
      start: plan.start ? { get: await sign(plan.start.key) } : null,
      shots: [],
    };
    const meta = { sid: scene.sid, gen, seconds: plan.seconds, images: plan.images, keyframeKey: kfKey, startKey, rates: fp.filmPricing(), shots: [] };
    for (const [i, sh] of shots.entries()) {
      const vk = base(`${sh.sid}-g${gen}.mp4`);
      const fk = base(`${sh.sid}-g${gen}.jpg`);
      const seed = seedOf();
      const s = { id: sh.sid, prompt: sh.prompt || '', duration: sh.duration, seed, camera: scene.camera, videoPut: await putUrl(vk), framePut: await putUrl(fk), frameGet: await sign(fk) };
      if (i === 0 && startKey) { s.startPut = await putUrl(startKey); s.startGet = await sign(startKey); }
      spec.shots.push(s);
      meta.shots.push({ sid: sh.sid, duration: sh.duration, seed, prompt: sh.prompt || '', videoKey: vk, frameKey: fk });
    }
    out = await billAndSubmit(req, {
      charge: { amount: plan.price, note: `Phim AI: cảnh ${idx + 1} (${plan.seconds}s${plan.images ? ` + ${plan.images} ảnh` : ''})`, meta: { kind: 'film-scene', unit: 'seconds', quantity: plan.seconds, images: plan.images, project: String(p._id) } },
      path: '/film/scene', body: spec,
      job: { kind: 'film-scene', project: p._id, prompt: scene.prompt.slice(0, 1000), meta },
    });
    } catch (e) { await unclaim(); throw e; }
    if (out.error) { await unclaim(); return fail(res, out.status, out.error); }
    const saved = await mutate(p._id, (doc) => {
      const s = doc.scenes.find((x) => x.sid === out.job.meta.sid);
      if (!s) return false;
      const gen = out.job.meta.gen;
      s.generation = gen; s.status = 'generating'; s.error = ''; s.duration = plan.seconds;
      s.shots = shots.map((sh) => ({ ...(sh.toObject ? sh.toObject() : sh), status: 'generating', error: '' }));
      return true;
    });
    res.status(202).json({ job: jobView(out.job), price: plan.price, project: await view(saved) });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_WALLET') return fail(res, 402, 'INSUFFICIENT_WALLET', { available: e.available });
    if (e.code === 'WALLET_BUSY') return fail(res, 503, 'STUDIO_UNAVAILABLE');
    next(e);
  }
});

/* ------------------------------------------------------------------ render -- */
router.post('/projects/:id/render', authenticate, async (req, res, next) => {
  try {
    const p = await ownProject(req, res);
    if (!p) return;
    if (!(await availability()).film) return fail(res, 503, 'STUDIO_UNAVAILABLE');
    if (!p.scenes.length) return fail(res, 400, 'BAD_INPUT');
    const notReady = p.scenes.filter((s) => (s.source === 'upload'
      ? !(p.uploads.find((u) => u.uid === s.uploadId && u.status === 'ready'))
      : !(s.shots.length && s.shots.every((sh) => sh.active >= 0)) || s.status === 'generating')).map((s) => s.sid);
    if (notReady.length) return fail(res, 409, 'NOT_READY', { scenes: notReady });
    if (projectSeconds(p) > fp.PROJECT_MAX_SEC) return fail(res, 400, 'TOO_LONG');
    if (await StudioJob.countDocuments({ project: p._id, kind: 'film-render', status: { $in: ['queued', 'running'] } })) return fail(res, 409, 'BUSY');
    const rp = renderPlan(p);
    if (!priceGate(req, res, rp.price)) return;

    const segments = [];
    for (const s of p.scenes) {
      const videos = s.source === 'upload'
        ? [await sign(p.uploads.find((u) => u.uid === s.uploadId).key)]
        : await Promise.all(s.shots.map((sh) => sign(sh.versions[sh.active].videoKey)));
      segments.push({ kind: s.source, videos, narration: s.narration ? { text: s.narration, voice: s.voice || 'Binh', lang: p.lang || 'vi' } : null });
    }
    const music = p.music.uploadId ? p.uploads.find((u) => u.uid === p.music.uploadId && u.status === 'ready') : null;
    const rk = key(p, 'renders', `${Date.now().toString(36)}-${newSid()}.mp4`);
    const out = await billAndSubmit(req, {
      charge: { amount: rp.price, note: `Phim AI: lồng tiếng khi xuất phim (${rp.chars} ký tự)`, meta: { kind: 'film-render', unit: 'characters', quantity: rp.chars, project: String(p._id) } },
      path: '/film/render',
      body: { segments, music: music ? { get: await sign(music.key), volume: p.music.volume } : null, put: await putUrl(rk) },
      job: { kind: 'film-render', project: p._id, prompt: p.title, meta: { key: rk, chars: rp.chars } },
    });
    if (out.error) return fail(res, out.status, out.error);
    const saved = await mutate(p._id, (doc) => { doc.renders.push({ job: out.job._id, key: rk, status: 'queued' }); doc.renders = doc.renders.slice(-20); });
    res.status(202).json({ job: jobView(out.job), price: rp.price, project: await view(saved) });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_WALLET') return fail(res, 402, 'INSUFFICIENT_WALLET', { available: e.available });
    if (e.code === 'WALLET_BUSY') return fail(res, 503, 'STUDIO_UNAVAILABLE');
    next(e);
  }
});

/* -------------------------------------------------------------- settlement -- */
function jobView(j) {
  return {
    id: String(j._id), kind: j.kind, status: j.status, charged: j.charged, refunded: j.refunded, refundedAmount: j.refundedAmount || 0,
    stage: (j.$locals && j.$locals.stage) || null, shots: (j.$locals && j.$locals.shots) || null, error: j.error || '', createdAt: j.createdAt,
  };
}

/** Apply a finished scene job to its project: new versions for produced shots; failed shots keep their old take. */
function applyScene(doc, job, remote) {
  const m = job.meta || {};
  const s = doc.scenes.find((x) => x.sid === m.sid);
  if (!s || s.generation !== m.gen) return false;
  const rs = (remote && remote.shots) || [];
  let ok = 0;
  m.shots.forEach((ms, i) => {
    const r = rs[i] || {};
    const sh = s.shots.find((x) => x.sid === ms.sid);
    if (!sh) return;
    if (r.status === 'succeeded') {
      ok += 1;
      sh.versions.push({ v: (sh.versions.length ? sh.versions[sh.versions.length - 1].v : 0) + 1, videoKey: ms.videoKey, frameKey: ms.frameKey, startKey: i === 0 ? (m.startKey || m.keyframeKey || '') : '', prompt: ms.prompt, seed: ms.seed, seconds: ms.duration, job: job._id });
      if (sh.versions.length > MAX_VERSIONS) sh.versions.splice(0, sh.versions.length - MAX_VERSIONS);
      sh.active = sh.versions.length - 1; sh.status = 'ready'; sh.error = '';
    } else {
      sh.status = sh.active >= 0 ? 'ready' : 'failed';
      sh.error = String(r.error || job.error || 'failed').slice(0, 200);
    }
  });
  if (m.keyframeKey && remote && remote.keyframe && remote.keyframe.status === 'succeeded') {
    s.keyframes.push({ v: s.keyframes.length + 1, frameKey: m.keyframeKey, job: job._id });
    if (s.keyframes.length > MAX_VERSIONS) s.keyframes.splice(0, s.keyframes.length - MAX_VERSIONS);
  }
  s.status = ok === m.shots.length ? 'ready' : ok ? 'partial' : (s.shots.every((x) => x.active >= 0) ? 'ready' : 'failed');
  s.error = ok === m.shots.length ? '' : String((remote && remote.error) || job.error || 'failed').slice(0, 200);
  return true;
}

/** Poll the AI job; on a terminal state settle once (refund unproduced seconds/images) and update the project. */
async function refreshFilmJob(job) {
  if (job.status !== 'queued' && job.status !== 'running') return job;
  const r = await gpuFetch(`/film/jobs/${job.remoteId}`, { timeout: 15000 }).catch(() => null);
  let remote = null;
  if (r && r.ok) remote = await r.json().catch(() => null);
  const lost = (r && r.status === 404) || (!remote && Date.now() - new Date(job.createdAt).getTime() > STALE_MS);
  if (!remote && !lost) return job;
  const st = lost ? 'failed' : remote.status;
  if (st === 'queued' || st === 'running') {
    if (job.status !== st) { job.status = st; await job.save(); }
    job.$locals.stage = remote.stage || null;
    job.$locals.shots = (remote.shots || []).map((x) => ({ id: x.id, status: x.status }));
    return job;
  }
  // Terminal: what was actually produced?
  const m = job.meta || {};
  let okSeconds = 0;
  let okImages = 0;
  if (!lost && job.kind === 'film-scene' || (!lost && job.kind === 'fast' && m.film)) {
    const rs = remote.shots || [];
    okSeconds = (m.shots || []).reduce((a, ms, i) => a + ((rs[i] || {}).status === 'succeeded' ? ms.duration : 0), 0);
    okImages = m.keyframeKey && remote.keyframe && remote.keyframe.status === 'succeeded' ? 1 : 0;
  } else if (!lost && job.kind === 'film-image') {
    okImages = st === 'succeeded' ? 1 : 0;
  }
  let refund;
  if (job.kind === 'film-render') refund = st === 'succeeded' ? 0 : job.charged;
  else refund = fp.filmRefund({ charged: job.charged, okSeconds, okImages, rates: m.rates });
  const produced = job.kind === 'film-render' ? st === 'succeeded' : okSeconds > 0 || (job.kind === 'film-image' && okImages > 0);
  const final = produced ? 'succeeded' : 'failed';
  const error = lost ? 'lost' : String(remote.error || '').slice(0, 300);
  const upd = await StudioJob.updateOne({ _id: job._id, settled: { $ne: true } }, {
    $set: { settled: true, status: final, error, refunded: refund > 0, refundedAmount: refund, ...(remote && remote.cost != null ? { 'meta.runpodCost': remote.cost } : {}), ...(remote && remote.duration ? { 'meta.duration': remote.duration } : {}) },
  });
  job.status = final; job.error = error; job.refunded = refund > 0; job.refundedAmount = refund; job.settled = true;
  if (!upd.modifiedCount) return job; // someone else settled it
  if (refund > 0) {
    await credit(job.user, refund, `Hoàn phí phim AI (${job.kind === 'film-render' ? 'xuất phim lỗi' : `${fp.round6(refund)} USD phần lỗi`}) ${job.remoteId.slice(0, 8)}`, { kind: job.kind, remoteId: job.remoteId, job: String(job._id) });
  }
  if (job.project) {
    await mutate(job.project, (doc) => {
      if (job.kind === 'film-scene') return applyScene(doc, job, lost ? null : remote);
      if (job.kind === 'film-render') {
        const rr = doc.renders.find((x) => String(x.job) === String(job._id));
        if (!rr) return false;
        rr.status = final; rr.duration = (remote && remote.duration) || 0; rr.bytes = (remote && remote.bytes) || 0;
        return true;
      }
      if (job.kind === 'film-image' && typeof module.exports.applyImage === 'function') return module.exports.applyImage(doc, job, remote, final);
      return false;
    }).catch((e) => console.error('[film] apply', String(job._id), e.message));
  }
  if (typeof module.exports.afterSettle === 'function') await module.exports.afterSettle(job, remote, final).catch(() => {});
  return job;
}

router.get('/jobs/:id', authenticate, async (req, res, next) => {
  try {
    const job = await StudioJob.findOne({ _id: req.params.id, user: req.user._id, kind: { $in: FILM_KINDS } }).catch(() => null);
    if (!job) return fail(res, 404, 'NOT_FOUND');
    await refreshFilmJob(job);
    res.json(jobView(job));
  } catch (e) { next(e); }
});

/* ------------------------------------------------- fast video on RunPod -- */
/**
 * /v1/studio/video/fast when the 5090 is unreachable: one 5 s Wan 2.2 I2V shot (start = the user's image,
 * else a Qwen first frame from the prompt). Billed per second (+ image), no free quota, refunded on failure.
 */
async function fastViaFilm(req, res, { prompt, imageBuffer }) {
  const userId = req.user._id;
  const id = newSid() + newSid();
  const k = (n) => minio.filmObjectName(userId, 'fast', id, n);
  const images = imageBuffer ? 0 : 1;
  const price = fp.filmCharge({ seconds: 5, images });
  const startKey = k('start.jpg');
  if (imageBuffer) {
    const cfg = await minio.ensurePlaygroundBucket();
    await minio.getMinioClient().putObject(cfg.bucket, k('input.img'), imageBuffer, imageBuffer.length, { 'Content-Type': 'application/octet-stream' });
  }
  const spec = {
    scene: { prompt: prompt || 'gentle natural motion, cinematic', camera: 'static' },
    keyframe: imageBuffer ? null : { mode: 'keyframe', prompt, images: [], put: await putUrl(startKey), get: await sign(startKey), seed: seedOf() },
    start: imageBuffer ? { get: await sign(k('input.img')) } : null,
    shots: [{ id: 's1', prompt: '', duration: 5, seed: seedOf(), camera: 'static', videoPut: await putUrl(k('video.mp4')), framePut: await putUrl(k('frame.jpg')), frameGet: await sign(k('frame.jpg')), ...(imageBuffer ? { startPut: await putUrl(startKey), startGet: await sign(startKey) } : {}) }],
  };
  const meta = { film: true, seconds: 5, images, keyframeKey: imageBuffer ? '' : startKey, rates: fp.filmPricing(), videoKey: k('video.mp4'), imageKey: startKey, shots: [{ sid: 's1', duration: 5 }] };
  try {
    const out = await billAndSubmit(req, {
      charge: { amount: price, note: `AI Studio video nhanh (5s${images ? ' + 1 ảnh' : ''})`, meta: { kind: 'fast', unit: 'seconds', quantity: 5, images } },
      path: '/film/scene', body: spec, job: { kind: 'fast', prompt, meta },
    });
    if (out.error) return fail(res, out.status, out.error);
    return res.status(202).json({ id: String(out.job._id), status: 'queued', free: false, charged: price, remainingFree: 0, position: null });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_WALLET') return res.status(402).json({ code: 'INSUFFICIENT_WALLET', message: MESSAGES.INSUFFICIENT_WALLET, price });
    throw e;
  }
}

/** Stream a MinIO-backed studio file (fast video via RunPod). */
async function streamFilmFile(job, res, which) {
  const k = which === 'jpg' ? job.meta.imageKey || '' : job.meta.videoKey;
  if (!k) return res.status(404).json({ message: 'Not found' });
  const cfg = await minio.ensurePlaygroundBucket();
  const obj = await minio.getMinioClient().getObject(cfg.bucket, k).catch(() => null);
  if (!obj) return res.status(410).json({ message: 'File đã hết hạn' });
  res.set('content-type', which === 'jpg' ? 'image/jpeg' : 'video/mp4');
  res.set('cache-control', 'private, max-age=600');
  obj.pipe(res);
  return null;
}

/** Background poller hook: finishes film jobs whose tab closed. */
async function pollFilmJobs(limit = 25) {
  const rows = await StudioJob.find({ $or: [{ kind: { $in: FILM_KINDS } }, { kind: 'fast', 'meta.film': true }], status: { $in: ['queued', 'running'] }, updatedAt: { $lt: new Date(Date.now() - 10000) } }).sort({ updatedAt: 1 }).limit(limit);
  for (const j of rows) await refreshFilmJob(j).catch((e) => console.error('[film] refresh', String(j._id), e.message));
}

module.exports = router;
Object.assign(module.exports, {
  availability, refreshFilmJob, fastViaFilm, streamFilmFile, pollFilmJobs, FILM_KINDS,
  _internal: { sceneIn, scenePlan, renderPlan, applyScene, planShots, projectSeconds, priceGate, debit, credit, mutate, view, key, sign, putUrl, billAndSubmit, checkActive, newSid, seedOf, fail, clean, jobView },
});
