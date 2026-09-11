const express = require('express');
const multer = require('multer');
const Product = require('../models/Product');
const ContentEpisode = require('../models/ContentEpisode');
const { authenticate, requireRoles } = require('../middleware/auth');
const { isWatchContentCategory } = require('../utils/license-keys');
const {
  findActiveLicense,
  issuePlayToken,
  takePlayToken,
  packAimc,
  publicEpisode,
  episodeDek,
} = require('../utils/content-drm');
const {
  isMinioEnabled,
  uploadContentBuffer,
  getContentObjectStream,
} = require('../config/minio');

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

function canManage(req, product) {
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;
  return String(product.creator) === String(req.user._id);
}

async function assertCanPlay(req, episode) {
  const productId = String(episode.product);
  if (req.user && (req.user.role === 'admin' || String(episode.seller) === String(req.user._id))) {
    return { ok: true, license: null, seller: true };
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
  requireRoles('creator', 'admin'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.productId);
      if (!product) return res.status(404).json({ message: 'Product not found' });
      if (!isWatchContentCategory(product.category)) {
        return res.status(400).json({ message: 'Only AI films and stories accept chapters' });
      }
      if (!canManage(req, product)) return res.status(403).json({ message: 'Forbidden' });

      const title = String(req.body?.title || req.file?.originalname || 'Untitled').trim().slice(0, 200);
      const last = await ContentEpisode.findOne({ product: product._id }).sort({ index: -1 }).lean();
      const index = Math.max(1, Number(req.body?.index) || (last?.index || 0) + 1);

      let objectName = '';
      let bucket = '';
      let contentType = String(req.file?.mimetype || req.body?.contentType || '').trim();
      let size = req.file?.size || 0;
      let sourceUrl = String(req.body?.sourceUrl || '').trim();

      if (req.file) {
        if (!isMinioEnabled()) {
          return res.status(503).json({ message: 'Media upload is not configured (MinIO)', code: 'MINIO_NOT_CONFIGURED' });
        }
        const uploaded = await uploadContentBuffer(req.file.buffer, {
          filename: req.file.originalname,
          contentType: req.file.mimetype,
        });
        objectName = uploaded.objectName;
        bucket = uploaded.bucket;
        contentType = req.file.mimetype;
        size = req.file.size;
        sourceUrl = '';
      } else if (!sourceUrl) {
        return res.status(400).json({ message: 'file or sourceUrl required' });
      }

      const kind = String(req.body?.kind || kindFromMime(contentType, req.file?.originalname));
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

router.delete('/episodes/:id', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
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
    const gate = await assertCanPlay(req, episode);
    const token = issuePlayToken({
      episodeId: episode._id,
      productId: episode.product,
      licenseId: gate.license?._id,
      mime: episode.contentType,
    });
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({
      ok: true,
      playUrl: `${origin}/v1/content/play/${token}`,
      downloadUrl: `${origin}/v1/content/episodes/${episode._id}/download`,
      kind: episode.kind,
      mime: episode.contentType,
      title: episode.title,
      expiresIn: 300,
      licenseExpiresAt: gate.license?.expiresAt || null,
      /** Only for in-app decrypt of .aimc — omitted after license expiry. */
      dek: episodeDek(episode._id).toString('base64'),
      drm: 'aimc-v1',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message, code: err.code });
    next(err);
  }
});

router.get('/play/:token', async (req, res, next) => {
  try {
    const row = takePlayToken(req.params.token);
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

    res.setHeader('Content-Type', episode.contentType || row.mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-DRM', 'aimc-v1');

    if (episode.objectName) {
      const stream = await getContentObjectStream(episode.objectName);
      stream.on('error', (err) => next(err));
      return stream.pipe(res);
    }
    if (episode.sourceUrl) {
      const up = await fetch(episode.sourceUrl, { redirect: 'follow' });
      if (!up.ok) return res.status(502).json({ message: 'Source media unavailable' });
      res.setHeader('Content-Type', up.headers.get('content-type') || episode.contentType || 'application/octet-stream');
      const { Readable } = require('stream');
      return Readable.fromWeb(up.body).pipe(res);
    }
    return res.status(404).json({ message: 'No media' });
  } catch (err) {
    next(err);
  }
});

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
      const up = await fetch(episode.sourceUrl, { redirect: 'follow' });
      if (!up.ok) return res.status(502).json({ message: 'Source media unavailable' });
      plain = Buffer.from(await up.arrayBuffer());
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

module.exports = router;
