const express = require('express');
const multer = require('multer');
const Product = require('../models/Product');
const ContentEpisode = require('../models/ContentEpisode');
const { authenticate, optionalAuth, requireRoles } = require('../middleware/auth');
const { isWatchContentCategory } = require('../utils/license-keys');
const {
  findActiveLicense,
  issuePlayToken,
  takePlayToken,
  packAimc,
  publicEpisode,
  resolveEpisodePages,
} = require('../utils/content-drm');
const {
  isMinioEnabled,
  uploadContentBuffer,
  getContentObjectStream,
} = require('../config/minio');
const minioCfg = require('../config/minio');
const { playableSourceUrl } = require('../data/content-hub-products');
const { fetchSafeHttp } = require('../utils/safe-http-url');
const online = require('../utils/online-access');
const storyNarration = require('../utils/story-narration');
const { gpuConfig, gpuFetch } = require('../utils/aimx-gpu');

const router = express.Router();

const MEDIA_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'text/plain',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const mime = String(file.mimetype || '').toLowerCase();
    const name = String(file.originalname || '').toLowerCase();
    const ok =
      MEDIA_TYPES.has(mime) ||
      /\.(mp4|webm|mov|jpg|jpeg|png|webp|gif|mp3|wav|txt)$/.test(name);
    if (ok) cb(null, true);
    else cb(new Error('Unsupported media type for film/story chapter'));
  },
});

const uploadChapter = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'files', maxCount: 40 },
]);

function uploadedFiles(req) {
  const bag = req.files || {};
  return [...(bag.files || []), ...(bag.file || [])].filter(Boolean);
}

function kindFromMime(mime, name = '') {
  const m = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (m.startsWith('video/') || /\.(mp4|webm|mov)$/.test(n)) return 'video';
  if (m.startsWith('audio/') || /\.(mp3|wav)$/.test(n)) return 'audio';
  if (m.startsWith('text/') || /\.txt$/.test(n)) return 'text';
  return 'image';
}

async function syncEpisodeCount(productId) {
  const n = await ContentEpisode.countDocuments({ product: productId, published: true });
  await Product.updateOne(
    { _id: productId, category: { $in: ['ai-film-series', 'story-book'] } },
    { $set: { 'contentMeta.episodeCount': n } },
  );
}

function publicApiOrigin(req) {
  const env = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (env) return env;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

function canManage(req, product) {
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;
  return String(product.creator) === String(req.user._id);
}

async function assertCanPlay(req, episode, { allowFree = false } = {}) {
  const productId = String(episode.product);
  const sellerId = episode.seller ? String(episode.seller) : '';
  const userId = req.user?._id ? String(req.user._id) : '';
  if (req.user && req.user.role === 'admin') return { ok: true, license: null, seller: true, via: 'moderation' };
  if (req.user && sellerId && userId && sellerId === userId) return { ok: true, license: null, seller: true, via: 'owner' };
  if (allowFree && episode.free === true && req.user) {
    return { ok: true, license: null, seller: false, free: true, via: 'free' };
  }
  // Owner-bound: findActiveLicense ignores keys that were issued to another account.
  const license = await findActiveLicense({
    buyerId: req.user?._id,
    licenseKey: req.body?.licenseKey || req.query?.licenseKey || req.get('x-license-key'),
    productId,
  });
  if (!license) {
    const code = await online.missingLicenseReason({
      userId: req.user?._id,
      productId,
      licenseKey: req.body?.licenseKey || req.query?.licenseKey || req.get('x-license-key'),
    });
    const err = new Error(code === 'LICENSE_EXPIRED' ? 'License expired. Renew it to keep watching or reading.' : 'Active license required to watch or read');
    err.status = 402;
    err.code = code;
    throw err;
  }
  return { ok: true, license, seller: false, via: 'license' };
}

function maskKey(key) {
  const k = String(key || '');
  return k.length > 9 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k;
}

function maskEmail(email) {
  const [u, d] = String(email || '').split('@');
  if (!d) return '';
  return `${u.slice(0, 2)}***@${d}`;
}

router.get('/products/:slug/episodes', async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    const product = await Product.findOne({ slug }).lean();
    if (!product || !isWatchContentCategory(product.category)) {
      return res.status(404).json({ message: 'Not found' });
    }
    const rows = await ContentEpisode.find({ product: product._id, published: true })
      .sort({ index: 1, createdAt: 1 })
      .lean();
    res.json(rows.map(publicEpisode));
  } catch (err) {
    next(err);
  }
});

router.post(
  '/products/:productId/episodes',
  authenticate,
  requireRoles('seller', 'admin'),
  uploadChapter,
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.productId);
      if (!product) return res.status(404).json({ message: 'Product not found' });
      if (!isWatchContentCategory(product.category)) {
        return res.status(400).json({ message: 'Only AI films and stories accept chapters' });
      }
      if (!canManage(req, product)) return res.status(403).json({ message: 'Forbidden' });

      const files = uploadedFiles(req);
      const title = String(req.body?.title || files[0]?.originalname || 'Untitled').trim().slice(0, 200);
      const last = await ContentEpisode.findOne({ product: product._id }).sort({ index: -1 }).lean();
      const index = Math.max(1, Number(req.body?.index) || (last?.index || 0) + 1);

      let objectName = '';
      let bucket = '';
      let contentType = String(req.body?.contentType || '').trim();
      let size = 0;
      let sourceUrl = String(req.body?.sourceUrl || '').trim();
      const pages = [];

      if (files.length) {
        if (!isMinioEnabled()) {
          return res.status(503).json({ message: 'Media upload is not configured (MinIO)', code: 'MINIO_NOT_CONFIGURED' });
        }
        let i = 1;
        for (const file of files) {
          const uploaded = await uploadContentBuffer(file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
          });
          const page = {
            index: i,
            objectName: uploaded.objectName,
            bucket: uploaded.bucket,
            contentType: file.mimetype,
            size: file.size,
            sourceUrl: '',
          };
          pages.push(page);
          if (i === 1) {
            objectName = page.objectName;
            bucket = page.bucket;
            contentType = page.contentType;
            size = page.size;
            sourceUrl = '';
          }
          i += 1;
        }
      } else if (!sourceUrl) {
        return res.status(400).json({ message: 'file or sourceUrl required' });
      }

      const kind = String(req.body?.kind || kindFromMime(contentType || files[0]?.mimetype, files[0]?.originalname));
      const episode = await ContentEpisode.create({
        product: product._id,
        seller: product.creator,
        index,
        title,
        kind: ['video', 'image', 'audio', 'text'].includes(kind) ? kind : 'image',
        objectName,
        bucket,
        contentType,
        size,
        durationSec: Math.max(0, Number(req.body?.durationSec) || 0),
        sourceUrl,
        previewUrl: String(req.body?.previewUrl || '').trim(),
        synopsis: String(req.body?.synopsis || '').slice(0, 2000),
        free: req.body?.free === true || req.body?.free === 'true',
        posterUrl: String(req.body?.posterUrl || '').trim().slice(0, 800),
        pages,
        published: req.body?.published !== 'false',
      });
      await syncEpisodeCount(product._id);
      res.status(201).json(publicEpisode(episode));
    } catch (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'Chapter file must be 80MB or smaller' });
      }
      next(err);
    }
  },
);

router.delete('/episodes/:id', authenticate, requireRoles('seller', 'admin'), async (req, res, next) => {
  try {
    const episode = await ContentEpisode.findById(req.params.id);
    if (!episode) return res.status(404).json({ message: 'Not found' });
    const product = await Product.findById(episode.product);
    if (!product || !canManage(req, product)) return res.status(403).json({ message: 'Forbidden' });
    await episode.deleteOne();
    await syncEpisodeCount(episode.product);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------ story narration (TTS synced to text) -- */
const NARRATION_LANGS = new Set(['vi', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ar', 'hi', 'th', 'id', 'ms', 'nl', 'pl', 'tr', 'sv', 'da', 'fi', 'no', 'el', 'he', 'sw']);
const NARRATION_DAILY = Number(process.env.STORY_NARRATION_DAILY || 40);
const NARRATION_STALE_MS = 45 * 60e3;
const narrationPolls = new Map();

async function readChapterText(ep) {
  const page = resolveEpisodePages(ep)[0] || {};
  const objectName = page.objectName || ep.objectName;
  if (!objectName) return null;
  const stream = await getContentObjectStream(objectName);
  const chunks = [];
  let size = 0;
  for await (const c of stream) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('Chapter text too large'), { status: 413 });
    chunks.push(c);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), type: page.contentType || ep.contentType || 'text/plain' };
}

function narrationView(ep) {
  const n = ep.narration || {};
  return {
    id: String(ep._id),
    title: ep.title,
    forEpisode: n.forEpisode ? String(n.forEpisode) : null,
    status: n.status || null,
    lang: n.lang,
    voice: n.voice,
    model: n.model,
    error: n.error || '',
    published: ep.published !== false,
    durationSec: ep.durationSec || 0,
    segments: (n.segments || []).length,
    ttsChars: n.ttsChars || 0,
    finishedAt: n.finishedAt || null,
  };
}

/** Pull the AI job into the narration episode; on success publish it and retire older narrations of the chapter. */
async function refreshNarration(ep) {
  const n = ep.narration;
  if (!n || n.status !== 'generating' || !n.jobId) return ep;
  const r = await gpuFetch(`/film/jobs/${n.jobId}`, { timeout: 15000 }).catch(() => null);
  if (r && r.status === 404) {
    n.status = 'failed';
    n.error = 'lost';
  } else if (r && r.ok) {
    const j = await r.json();
    if (j.status === 'succeeded') {
      const byId = new Map((j.segments || []).map((t) => [String(t.id), t]));
      const segs = (n.segments || []).map((sg, i) => {
        const t = byId.get(String(i)) || {};
        return { p: sg.p, c0: sg.c0, c1: sg.c1, start: Number(t.start) || 0, end: Number(t.end) || 0 };
      });
      const stat = await minioCfg.statContentObject(ep.objectName).catch(() => null);
      if (!stat || segs.some((sg) => !(sg.end > sg.start))) {
        n.status = 'failed';
        n.error = stat ? 'bad timing' : 'audio missing';
      } else {
        n.segments = segs;
        n.status = 'ready';
        n.model = j.model || n.model;
        n.ttsChars = Number(j.ttsChars) || n.ttsChars;
        n.cost = Number(j.cost) || 0;
        n.finishedAt = new Date();
        ep.size = Number(stat.size) || 0;
        ep.contentType = 'audio/mpeg';
        ep.durationSec = Math.round(Number(j.duration) || 0);
        ep.published = true;
      }
    } else if (j.status === 'failed') {
      n.status = 'failed';
      n.error = String(j.error || 'failed').slice(0, 500);
    }
  }
  if (n.status === 'generating' && Date.now() - new Date(ep.updatedAt || ep.createdAt).getTime() > NARRATION_STALE_MS) {
    n.status = 'failed';
    n.error = 'timeout';
  }
  ep.markModified('narration');
  await ep.save();
  if (n.status === 'ready') {
    // Older narrations of the same chapter stay in storage (reversible) but leave the reader.
    await ContentEpisode.updateMany(
      { product: ep.product, kind: 'audio', _id: { $ne: ep._id }, 'narration.forEpisode': n.forEpisode },
      { $set: { published: false } },
    );
    await syncEpisodeCount(ep.product);
  }
  return ep;
}

function pollNarration(id) {
  if (narrationPolls.has(String(id))) return;
  const started = Date.now();
  const tick = async () => {
    try {
      const ep = await ContentEpisode.findById(id);
      if (ep) await refreshNarration(ep);
      if (!ep || ep.narration?.status !== 'generating' || Date.now() - started > NARRATION_STALE_MS + 60e3) {
        narrationPolls.delete(String(id));
        return;
      }
    } catch {
      /* next tick */
    }
    narrationPolls.set(String(id), setTimeout(tick, 6000).unref());
  };
  narrationPolls.set(String(id), setTimeout(tick, 6000).unref());
}

/**
 * Seller / admin: narrate a text chapter. Each sentence is synthesized on its own (VieNeu for vi, Chatterbox for
 * other languages) so the reader gets exact start/end times and highlights what is being read.
 * Body: { lang?: 'vi', voice?: 'Binh'|'Ngoc'|…|'default' }. 202 + narration view; poll GET below.
 */
router.post('/episodes/:id/narration', authenticate, async (req, res, next) => {
  try {
    const chapter = await ContentEpisode.findById(req.params.id).catch(() => null);
    if (!chapter || chapter.kind !== 'text') return res.status(404).json({ message: 'Text chapter not found' });
    const product = await Product.findById(chapter.product).select('creator category').lean();
    if (!product || !canManage(req, product)) return res.status(403).json({ message: 'Forbidden' });
    if (!gpuConfig().enabled) return res.status(503).json({ message: 'Narration unavailable', code: 'STUDIO_UNAVAILABLE' });
    const lang = String(req.body?.lang || 'vi').toLowerCase().slice(0, 8);
    if (!NARRATION_LANGS.has(lang)) return res.status(400).json({ message: 'Unsupported language', code: 'BAD_LANG' });
    const voice = String(req.body?.voice || '').replace(/[^\w-]+/g, '').slice(0, 40);
    const busy = await ContentEpisode.findOne({
      'narration.forEpisode': chapter._id,
      'narration.status': 'generating',
      updatedAt: { $gt: new Date(Date.now() - NARRATION_STALE_MS) },
    }).lean();
    if (busy) return res.status(409).json({ message: 'Narration already generating', code: 'BUSY', narration: narrationView(busy) });
    if (req.user.role !== 'admin') {
      const today = await ContentEpisode.countDocuments({ 'narration.requestedBy': req.user._id, createdAt: { $gt: new Date(Date.now() - 864e5) } });
      if (today >= NARRATION_DAILY) return res.status(429).json({ message: 'Daily narration limit reached', code: 'RATE_LIMITED' });
    }
    const src = await readChapterText(chapter);
    if (!src) return res.status(400).json({ message: 'Chapter has no stored text', code: 'NO_TEXT' });
    const seg = storyNarration.segment(src.text, src.type);
    if (!seg.segments.length) return res.status(400).json({ message: 'Nothing to read', code: 'NO_TEXT' });
    if (seg.segments.length > 800 || src.text.length > 60000) return res.status(400).json({ message: 'Chapter too long to narrate', code: 'TOO_LONG' });

    const put = await minioCfg.presignContentPut('mp3', 6 * 3600, `narration-${chapter._id}`);
    const ep = await ContentEpisode.create({
      product: chapter.product,
      seller: chapter.seller,
      index: chapter.index,
      title: `Sách nói — ${chapter.title}`.slice(0, 200),
      kind: 'audio',
      objectName: put.objectName,
      bucket: put.bucket,
      contentType: 'audio/mpeg',
      published: false,
      free: chapter.free === true,
      narration: {
        forEpisode: chapter._id,
        status: 'generating',
        lang,
        voice,
        model: lang === 'vi' ? 'VieNeu-TTS' : 'Chatterbox-multilingual',
        textHash: storyNarration.textHash(src.text),
        paraCount: seg.paras.length,
        paraSig: seg.paraSig,
        segments: seg.segments.map(({ p, c0, c1 }) => ({ p, c0, c1, start: 0, end: 0 })),
        ttsChars: seg.segments.reduce((a, x) => a + x.text.length, 0),
        requestedBy: req.user._id,
      },
    });
    const r = await gpuFetch('/film/narration', {
      method: 'POST',
      timeout: 60000,
      body: JSON.stringify({ put: put.url, lang, voice, segments: seg.segments.map(({ id, p, text }) => ({ id, p, text })) }),
    }).catch(() => null);
    if (!r || !r.ok) {
      ep.narration.status = 'failed';
      ep.narration.error = r ? `submit HTTP ${r.status}` : 'submit failed';
      ep.markModified('narration');
      await ep.save();
      return res.status(r && r.status === 400 ? 400 : 503).json({ message: 'Narration could not start', code: 'STUDIO_UNAVAILABLE' });
    }
    const job = await r.json();
    ep.narration.jobId = String(job.id || '');
    ep.narration.voice = String(job.voice || voice);
    ep.markModified('narration');
    await ep.save();
    pollNarration(ep._id);
    res.status(202).json({ narration: narrationView(ep) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
});

/** Seller / admin: narrations of a chapter (newest first), refreshed from the AI job while generating. */
router.get('/episodes/:id/narration', authenticate, async (req, res, next) => {
  try {
    const chapter = await ContentEpisode.findById(req.params.id).select('product kind').lean().catch(() => null);
    if (!chapter) return res.status(404).json({ message: 'Not found' });
    const product = await Product.findById(chapter.product).select('creator').lean();
    if (!product || !canManage(req, product)) return res.status(403).json({ message: 'Forbidden' });
    const rows = await ContentEpisode.find({ 'narration.forEpisode': chapter._id }).sort({ createdAt: -1 }).limit(10);
    for (const row of rows) if (row.narration?.status === 'generating') await refreshNarration(row);
    res.json({ narrations: rows.map(narrationView) });
  } catch (err) {
    next(err);
  }
});

router.post('/unlock', authenticate, async (req, res, next) => {
  try {
    const episodeId = String(req.body?.episodeId || '').trim();
    const episode = await ContentEpisode.findById(episodeId);
    if (!episode || episode.published === false) {
      return res.status(404).json({ message: 'Episode not found' });
    }
    const gate = await assertCanPlay(req, episode, { allowFree: true });
    const product = await Product.findById(episode.product).select('category slug creator').lean();
    // Dataset / skill files are never streamed to buyers: they use the rows API / server-side runs.
    if (!gate.seller && product && ['dataset', 'skill-pack'].includes(product.category)) {
      return res.status(403).json(online.onlineOnlyBody(product));
    }
    if (!gate.seller) {
      await online
        .takeQuota({ scope: online.usageScope(gate, req.user, product), kind: 'play', limits: online.quotaDefaults().play })
        .then((q) => q.commit(0));
    }
    const trace = online.traceId(gate.license?._id || req.user._id);
    const token = issuePlayToken({
      episodeId: episode._id,
      productId: episode.product,
      licenseId: gate.license?._id,
      mime: episode.contentType,
      userId: req.user._id,
      trace,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Trace-Id', trace);
    const origin = publicApiOrigin(req);
    const pages = resolveEpisodePages(episode);
    const playPath = (page) => {
      const q = `token=${encodeURIComponent(token)}&page=${Math.max(1, Number(page) || 1)}`;
      return origin ? `${origin}/v1/content/play?${q}` : `/v1/content/play?${q}`;
    };
    const first = pages[0]?.index || 1;
    res.json({
      ok: true,
      playToken: token,
      playUrl: playPath(first),
      // Online-only: only the listing owner / admin (moderation) get a download link.
      downloadUrl: gate.seller
        ? origin
          ? `${origin}/v1/content/episodes/${episode._id}/download`
          : `/v1/content/episodes/${episode._id}/download`
        : null,
      onlineOnly: true,
      access: gate.via,
      traceId: trace,
      watermark: gate.license
        ? [maskEmail(req.user.email), maskKey(gate.license.licenseKey), trace].filter(Boolean).join(' · ')
        : '',
      kind: episode.kind,
      mime: episode.contentType,
      title: episode.title,
      pageCount: pages.length,
      pages: pages.map((p) => ({ index: p.index, playUrl: playPath(p.index) })),
      expiresIn: 300,
      licenseExpiresAt: gate.license?.expiresAt || null,
      drm: 'aimc-v1',
      free: gate.free === true,
      // Story narration: per-sentence timing into the reader's paragraphs (offsets + paragraph hashes, no text).
      narration:
        episode.kind === 'audio' && episode.narration?.status === 'ready'
          ? {
              forEpisode: String(episode.narration.forEpisode),
              lang: episode.narration.lang,
              voice: episode.narration.voice,
              model: episode.narration.model,
              paraCount: episode.narration.paraCount,
              paraSig: episode.narration.paraSig,
              segments: episode.narration.segments.map((g) => [g.p, g.c0, g.c1, g.start, g.end]),
            }
          : null,
    });
  } catch (err) {
    if (err.status === 429) return online.sendQuotaError(res, err);
    if (err.status) return res.status(err.status).json({ message: err.message, code: err.code });
    next(err);
  }
});

async function handlePlay(req, res, next) {
  try {
    const token = String(req.query?.token || req.query?.t || req.params?.token || '').trim();
    const row = takePlayToken(token);
    if (!row) return res.status(403).json({ message: 'Play token expired. Unlock again with a valid license.' });
    const episode = await ContentEpisode.findById(row.episodeId);
    if (!episode) return res.status(404).json({ message: 'Episode not found' });
    if (row.licenseId) {
      const LicenseKey = require('../models/LicenseKey');
      const { effectiveLicenseStatus } = require('../utils/license-keys');
      const doc = await LicenseKey.findById(row.licenseId);
      if (!doc || effectiveLicenseStatus(doc) !== 'active') {
        return res.status(402).json({ message: 'License expired', code: 'LICENSE_EXPIRED' });
      }
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-DRM', 'aimc-v1');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (row.trace) res.setHeader('X-Trace-Id', row.trace);
    // Reader pages (no Range header) count against the per-license read quota; video byte ranges don't.
    if (row.licenseId && !req.headers.range) {
      try {
        const q = await online.takeQuota({ scope: `lic:${row.licenseId}`, kind: 'read', limits: online.quotaDefaults().read });
        await q.commit(0);
      } catch (e) {
        if (e.status === 429) return online.sendQuotaError(res, e);
        throw e;
      }
    }

    const pages = resolveEpisodePages(episode);
    const pageNum = Math.max(1, Number(req.query?.page) || 1);
    const page = pages.find((p) => p.index === pageNum) || pages[0];
    if (!page) return res.status(404).json({ message: 'No media' });

    if (page.objectName) {
      res.setHeader('Content-Type', page.contentType || episode.contentType || row.mime || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      // Byte ranges so players can seek (resume position, ±5s) without re-downloading.
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
      if (range) {
        const cfg = await minioCfg.ensurePlaygroundBucket();
        const client = minioCfg.getMinioClient();
        const stat = await client.statObject(cfg.bucket, page.objectName);
        const total = Number(stat.size) || 0;
        let start = range[1] === '' ? Math.max(0, total - Number(range[2] || 0)) : Number(range[1]);
        let end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), total - 1) : total - 1;
        if (!total || start > end || start >= total) {
          res.setHeader('Content-Range', `bytes */${total}`);
          return res.status(416).end();
        }
        const part = await client.getPartialObject(cfg.bucket, page.objectName, start, end - start + 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', String(end - start + 1));
        part.on('error', (err) => next(err));
        return part.pipe(res);
      }
      const stream = await getContentObjectStream(page.objectName);
      stream.on('error', (err) => next(err));
      return stream.pipe(res);
    }
    const sourceUrl = playableSourceUrl(page.sourceUrl || episode.sourceUrl, page.index || episode.index);
    if (sourceUrl) {
      res.setHeader('Content-Type', page.contentType || episode.contentType || row.mime || 'image/jpeg');
      return res.redirect(302, sourceUrl);
    }
    return res.status(404).json({ message: 'No media' });
  } catch (err) {
    next(err);
  }
}

router.get('/play', handlePlay);
router.get('/play/:token', handlePlay);

router.get('/episodes/:id/download', authenticate, async (req, res, next) => {
  try {
    const episode = await ContentEpisode.findById(req.params.id);
    if (!episode) return res.status(404).json({ message: 'Not found' });
    const gate = await assertCanPlay(req, episode);
    if (!gate.seller) {
      // Online-only: licensed buyers stream / read; only the owner and admins (moderation) download.
      const product = await Product.findById(episode.product).select('category slug').lean();
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(403).json(online.onlineOnlyBody(product || {}));
    }
    res.setHeader('X-Access', gate.via);
    let plain;
    if (episode.objectName) {
      const stream = await getContentObjectStream(episode.objectName);
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      plain = Buffer.concat(chunks);
    } else if (episode.sourceUrl) {
      const up = await fetchSafeHttp(playableSourceUrl(episode.sourceUrl, episode.index), {
        timeoutMs: 30000,
        maxBytes: 80 * 1024 * 1024,
        headers: { 'User-Agent': 'AI-Markets-Content/1.0' },
      });
      plain = up.buffer;
    } else {
      return res.status(404).json({ message: 'No media' });
    }
    const packed = packAimc({
      episodeId: episode._id,
      productId: episode.product,
      mime: episode.contentType,
      filename: `${episode.title || 'episode'}`,
      plain,
    });
    res.setHeader('Content-Type', 'application/vnd.aimarkets.content');
    res.setHeader('Content-Disposition', `attachment; filename="episode-${episode.index}.aimc"`);
    res.setHeader('X-Content-DRM', 'aimc-v1');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(packed);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message, code: err.code });
    next(err);
  }
});

// ---------- Series player: metadata, reactions, resume, seller editing ----------
const { SeriesReaction, WatchProgress } = require('../models/SeriesEngagement');

function cleanTags(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(arr.map((t) => String(t || '').trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
}

async function seriesCounts(productId, userId) {
  const [likes, saves, mine] = await Promise.all([
    SeriesReaction.countDocuments({ product: productId, kind: 'like' }),
    SeriesReaction.countDocuments({ product: productId, kind: 'save' }),
    userId ? SeriesReaction.find({ product: productId, user: userId }).select('kind').lean() : [],
  ]);
  const kinds = new Set(mine.map((r) => r.kind));
  return { likes, saves, liked: kinds.has('like'), saved: kinds.has('save') };
}

router.get('/products/:slug/series', optionalAuth, async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    const product = await Product.findOne({ slug }).lean();
    if (!product || !isWatchContentCategory(product.category)) return res.status(404).json({ message: 'Not found' });
    const userId = req.user?._id || null;
    const [rows, counts, progress] = await Promise.all([
      ContentEpisode.find({ product: product._id, published: true }).sort({ index: 1, createdAt: 1 }).lean(),
      seriesCounts(product._id, userId),
      userId ? WatchProgress.findOne({ user: userId, product: product._id }).lean() : null,
    ]);
    const meta = product.contentMeta || {};
    res.json({
      productId: String(product._id),
      slug: product.slug,
      title: product.name,
      synopsis: meta.synopsis || product.description || '',
      genres: (meta.genres && meta.genres.length ? meta.genres : product.tags || []).slice(0, 12),
      episodeCount: rows.length,
      ...counts,
      progress: progress ? { episodeId: String(progress.episode), positionSec: progress.positionSec || 0, fraction: progress.fraction || 0, page: progress.page || 0, updatedAt: progress.updatedAt, audio: progress.audioEpisode ? { episodeId: String(progress.audioEpisode), sec: progress.audioSec || 0 } : null } : null,
      bookmarks: progress ? (progress.bookmarks || []).map(publicBookmark) : [],
      episodes: rows.map(publicEpisode),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/products/:slug/reactions', authenticate, async (req, res, next) => {
  try {
    const kind = String(req.body?.kind || '');
    if (!['like', 'save'].includes(kind)) return res.status(400).json({ message: 'kind must be like or save' });
    const product = await Product.findOne({ slug: String(req.params.slug || '').toLowerCase() }).select('_id category').lean();
    if (!product || !isWatchContentCategory(product.category)) return res.status(404).json({ message: 'Not found' });
    const on = req.body?.on !== false && req.body?.on !== 'false';
    const key = { user: req.user._id, product: product._id, kind };
    if (on) await SeriesReaction.updateOne(key, { $setOnInsert: key }, { upsert: true });
    else await SeriesReaction.deleteOne(key);
    res.json(await seriesCounts(product._id, req.user._id));
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ message: 'Try again' });
    next(err);
  }
});

router.put('/products/:slug/progress', authenticate, async (req, res, next) => {
  try {
    const product = await Product.findOne({ slug: String(req.params.slug || '').toLowerCase() }).select('_id category').lean();
    if (!product || !isWatchContentCategory(product.category)) return res.status(404).json({ message: 'Not found' });
    const episode = await ContentEpisode.findOne({ _id: String(req.body?.episodeId || ''), product: product._id }).select('_id').lean().catch(() => null);
    if (!episode) return res.status(400).json({ message: 'episodeId invalid' });
    const positionSec = Math.max(0, Math.min(86400, Number(req.body?.positionSec) || 0));
    const fraction = Math.max(0, Math.min(1, Number(req.body?.fraction) || 0));
    const page = Math.max(0, Math.min(10000, Math.floor(Number(req.body?.page) || 0)));
    const set = { episode: episode._id, positionSec, fraction, page };
    // Story narration resume point (optional): audio episode of the same book + seconds.
    if (req.body?.audioEpisodeId) {
      const audio = await ContentEpisode.findOne({ _id: String(req.body.audioEpisodeId), product: product._id, kind: 'audio' }).select('_id').lean().catch(() => null);
      if (audio) {
        set.audioEpisode = audio._id;
        set.audioSec = Math.max(0, Math.min(86400, Number(req.body?.audioSec) || 0));
      }
    }
    await WatchProgress.updateOne({ user: req.user._id, product: product._id }, { $set: set }, { upsert: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function publicBookmark(b) {
  return { id: String(b._id), episodeId: String(b.episode), fraction: b.fraction || 0, page: b.page || 0, kind: b.kind || 'bookmark', quote: b.quote || '', note: b.note || '', color: b.color || 'yellow', createdAt: b.createdAt };
}

async function readerTarget(req, res) {
  const product = await Product.findOne({ slug: String(req.params.slug || '').toLowerCase() }).select('_id category').lean();
  if (!product || !isWatchContentCategory(product.category)) { res.status(404).json({ message: 'Not found' }); return null; }
  return product;
}

/** Reader bookmarks / highlights (max 200 per user and book). */
router.get('/products/:slug/bookmarks', authenticate, async (req, res, next) => {
  try {
    const product = await readerTarget(req, res);
    if (!product) return;
    const row = await WatchProgress.findOne({ user: req.user._id, product: product._id }).select('bookmarks').lean();
    res.json({ bookmarks: (row?.bookmarks || []).map(publicBookmark) });
  } catch (err) {
    next(err);
  }
});

router.post('/products/:slug/bookmarks', authenticate, async (req, res, next) => {
  try {
    const product = await readerTarget(req, res);
    if (!product) return;
    const episode = await ContentEpisode.findOne({ _id: String(req.body?.episodeId || ''), product: product._id }).select('_id').lean().catch(() => null);
    if (!episode) return res.status(400).json({ message: 'episodeId invalid' });
    const b = {
      episode: episode._id,
      fraction: Math.max(0, Math.min(1, Number(req.body?.fraction) || 0)),
      page: Math.max(0, Math.min(10000, Math.floor(Number(req.body?.page) || 0))),
      kind: req.body?.kind === 'highlight' ? 'highlight' : 'bookmark',
      quote: String(req.body?.quote || '').slice(0, 600),
      note: String(req.body?.note || '').slice(0, 1000),
      color: ['yellow', 'green', 'blue', 'pink'].includes(req.body?.color) ? req.body.color : 'yellow',
    };
    let row = await WatchProgress.findOne({ user: req.user._id, product: product._id });
    if (!row) row = new WatchProgress({ user: req.user._id, product: product._id, episode: episode._id });
    if ((row.bookmarks || []).length >= 200) return res.status(400).json({ message: 'Too many bookmarks' });
    row.bookmarks.push(b);
    await row.save();
    res.status(201).json({ bookmark: publicBookmark(row.bookmarks[row.bookmarks.length - 1]) });
  } catch (err) {
    next(err);
  }
});

router.delete('/products/:slug/bookmarks/:id', authenticate, async (req, res, next) => {
  try {
    const product = await readerTarget(req, res);
    if (!product) return;
    await WatchProgress.updateOne({ user: req.user._id, product: product._id }, { $pull: { bookmarks: { _id: String(req.params.id) } } }).catch(() => null);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Seller: series synopsis + genre tags. */
router.patch('/products/:productId/series', authenticate, requireRoles('seller', 'admin'), async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (!isWatchContentCategory(product.category)) return res.status(400).json({ message: 'Only AI films and stories' });
    if (!canManage(req, product)) return res.status(403).json({ message: 'Forbidden' });
    if (req.body?.synopsis != null) product.set('contentMeta.synopsis', String(req.body.synopsis).slice(0, 4000));
    if (req.body?.genres != null) product.set('contentMeta.genres', cleanTags(req.body.genres));
    await product.save();
    res.json({ ok: true, synopsis: product.contentMeta?.synopsis || '', genres: product.contentMeta?.genres || [] });
  } catch (err) {
    next(err);
  }
});

/** Seller: edit an episode (title, synopsis, free flag, order, poster, publish). */
router.patch('/episodes/:id', authenticate, requireRoles('seller', 'admin'), async (req, res, next) => {
  try {
    const episode = await ContentEpisode.findById(req.params.id);
    if (!episode) return res.status(404).json({ message: 'Not found' });
    const product = await Product.findById(episode.product);
    if (!product || !canManage(req, product)) return res.status(403).json({ message: 'Forbidden' });
    const b = req.body || {};
    if (b.title != null && String(b.title).trim()) episode.title = String(b.title).trim().slice(0, 200);
    if (b.synopsis != null) episode.synopsis = String(b.synopsis).slice(0, 2000);
    if (b.free != null) episode.free = b.free === true || b.free === 'true';
    if (b.index != null && Number(b.index) >= 1) episode.index = Math.floor(Number(b.index));
    if (b.posterUrl != null) episode.posterUrl = String(b.posterUrl).trim().slice(0, 800);
    if (b.durationSec != null) episode.durationSec = Math.max(0, Number(b.durationSec) || 0);
    if (b.published != null) episode.published = !(b.published === false || b.published === 'false');
    await episode.save();
    await syncEpisodeCount(episode.product);
    res.json(publicEpisode(episode));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
