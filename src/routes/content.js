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
  if (req.user && (req.user.role === 'admin' || (sellerId && userId && sellerId === userId))) {
    return { ok: true, license: null, seller: true };
  }
  if (allowFree && episode.free === true && req.user) {
    return { ok: true, license: null, seller: false, free: true };
  }
  const license = await findActiveLicense({
    buyerId: req.user?._id,
    licenseKey: req.body?.licenseKey || req.query?.licenseKey || req.get('x-license-key'),
    productId,
  });
  if (!license) {
    const err = new Error('Active license required to watch or download');
    err.status = 402;
    err.code = 'LICENSE_REQUIRED';
    throw err;
  }
  return { ok: true, license, seller: false };
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

router.post('/unlock', authenticate, async (req, res, next) => {
  try {
    const episodeId = String(req.body?.episodeId || '').trim();
    const episode = await ContentEpisode.findById(episodeId);
    if (!episode || episode.published === false) {
      return res.status(404).json({ message: 'Episode not found' });
    }
    const gate = await assertCanPlay(req, episode, { allowFree: true });
    const token = issuePlayToken({
      episodeId: episode._id,
      productId: episode.product,
      licenseId: gate.license?._id,
      mime: episode.contentType,
    });
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
      downloadUrl: origin ? `${origin}/v1/content/episodes/${episode._id}/download` : `/v1/content/episodes/${episode._id}/download`,
      kind: episode.kind,
      mime: episode.contentType,
      title: episode.title,
      pageCount: pages.length,
      pages: pages.map((p) => ({ index: p.index, playUrl: playPath(p.index) })),
      expiresIn: 300,
      licenseExpiresAt: gate.license?.expiresAt || null,
      drm: 'aimc-v1',
      free: gate.free === true,
    });
  } catch (err) {
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
    await assertCanPlay(req, episode);
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
      progress: progress ? { episodeId: String(progress.episode), positionSec: progress.positionSec || 0, fraction: progress.fraction || 0, page: progress.page || 0, updatedAt: progress.updatedAt } : null,
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
    await WatchProgress.updateOne(
      { user: req.user._id, product: product._id },
      { $set: { episode: episode._id, positionSec, fraction, page } },
      { upsert: true },
    );
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
