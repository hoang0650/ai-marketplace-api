/**
 * Downloadable files for licensed skill packs and datasets.
 *
 * Files are stored as ContentEpisode rows (objectName in the private content prefix), the same storage
 * the licensed-dataset training import already reads. Buyers with an active license (or the seller /
 * an admin) download the original bytes; everyone else only sees the file list.
 */
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const Product = require('../models/Product');
const ContentEpisode = require('../models/ContentEpisode');
const { authenticate, optionalAuth, requireRoles } = require('../middleware/auth');
const { findActiveLicense } = require('../utils/content-drm');
const minio = require('../config/minio');

const router = express.Router();

const DOWNLOAD_CATEGORIES = new Set(['skill-pack', 'dataset']);
const MAX_BYTES = 80 * 1024 * 1024;
const FILE_EXT_RE = /\.(zip|skill|jsonl|json|csv|tsv|parquet|md|txt|pdf|yaml|yml|tar|gz|tgz)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (FILE_EXT_RE.test(String(file.originalname || ''))) cb(null, true);
    else cb(Object.assign(new Error('Unsupported file type'), { status: 400, code: 'FILE_TYPE_NOT_ALLOWED' }));
  },
});

function isDownloadCategory(category) {
  return DOWNLOAD_CATEGORIES.has(String(category || ''));
}

function safeFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return base.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 160) || 'file.bin';
}

function publicFile(e) {
  return {
    id: String(e._id),
    index: e.index,
    filename: e.title,
    contentType: e.contentType || 'application/octet-stream',
    size: e.size || 0,
    description: e.synopsis || '',
    updatedAt: e.updatedAt,
  };
}

function isManager(user, product) {
  if (!user) return false;
  return user.role === 'admin' || String(product.creator) === String(user._id);
}

async function loadProduct(req) {
  const id = String(req.params.productId || '');
  if (!mongoose.isValidObjectId(id)) return null;
  const product = await Product.findById(id).select('name slug category creator').lean();
  if (!product || !isDownloadCategory(product.category)) return null;
  return product;
}

function licenseKeyOf(req) {
  return req.query?.licenseKey || req.get('x-license-key') || '';
}

/** GET /v1/product-files/:productId — file list (public) + whether the caller can download. */
router.get('/:productId', optionalAuth, async (req, res, next) => {
  try {
    const product = await loadProduct(req);
    if (!product) return res.status(404).json({ message: 'Not found' });
    const rows = await ContentEpisode.find({ product: product._id, published: true })
      .sort({ index: 1, createdAt: 1 })
      .lean();
    let unlocked = isManager(req.user, product);
    let license = null;
    if (!unlocked && req.user) {
      license = await findActiveLicense({ buyerId: req.user._id, licenseKey: licenseKeyOf(req), productId: product._id });
      unlocked = !!license;
    }
    res.json({
      files: rows.map(publicFile),
      unlocked,
      licenseExpiresAt: license?.expiresAt || null,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /v1/product-files/:productId/:fileId/download — original bytes, active license required. */
router.get('/:productId/:fileId/download', authenticate, async (req, res, next) => {
  try {
    const product = await loadProduct(req);
    if (!product) return res.status(404).json({ message: 'Not found' });
    const fileId = String(req.params.fileId || '');
    if (!mongoose.isValidObjectId(fileId)) return res.status(404).json({ message: 'File not found' });
    const file = await ContentEpisode.findOne({ _id: fileId, product: product._id, published: true }).lean();
    if (!file || !file.objectName) return res.status(404).json({ message: 'File not found' });
    if (!isManager(req.user, product)) {
      const license = await findActiveLicense({ buyerId: req.user._id, licenseKey: licenseKeyOf(req), productId: product._id });
      if (!license) {
        return res.status(402).json({ message: 'Active license required to download', code: 'LICENSE_REQUIRED' });
      }
    }
    if (!minio.isMinioEnabled()) return res.status(503).json({ message: 'Storage not configured', code: 'MINIO_NOT_CONFIGURED' });
    const stream = await minio.getContentObjectStream(file.objectName);
    const filename = safeFilename(file.title);
    res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
    if (file.size) res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', (err) => next(err));
    return stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

/** POST /v1/product-files/:productId — seller uploads a file (multipart field `file`, optional `description`). */
router.post('/:productId', authenticate, requireRoles('seller', 'admin'), (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        const tooLarge = uploadErr.code === 'LIMIT_FILE_SIZE';
        return res.status(tooLarge ? 413 : uploadErr.status || 400).json({
          message: tooLarge ? 'File too large (max 80 MB)' : uploadErr.message,
          code: tooLarge ? 'FILE_TOO_LARGE' : uploadErr.code || 'UPLOAD_FAILED',
        });
      }
      const product = await loadProduct(req);
      if (!product) return res.status(404).json({ message: 'Not found' });
      if (!isManager(req.user, product)) return res.status(403).json({ message: 'Forbidden' });
      if (!req.file) return res.status(400).json({ message: 'file required', code: 'FILE_REQUIRED' });
      if (!minio.isMinioEnabled()) return res.status(503).json({ message: 'Storage not configured', code: 'MINIO_NOT_CONFIGURED' });
      const filename = safeFilename(req.file.originalname);
      const contentType = String(req.file.mimetype || 'application/octet-stream').slice(0, 120);
      const uploaded = await minio.uploadContentBuffer(req.file.buffer, { filename, contentType });
      const last = await ContentEpisode.findOne({ product: product._id }).sort({ index: -1 }).lean();
      const doc = await ContentEpisode.create({
        product: product._id,
        seller: product.creator,
        index: (last?.index || 0) + 1,
        title: filename,
        kind: 'text',
        objectName: uploaded.objectName,
        bucket: uploaded.bucket,
        contentType,
        size: req.file.size,
        synopsis: String(req.body?.description || '').slice(0, 2000),
        published: true,
      });
      res.status(201).json({ file: publicFile(doc) });
    } catch (err) {
      next(err);
    }
  });
});

/** DELETE /v1/product-files/:productId/:fileId — seller removes a file and its stored object. */
router.delete('/:productId/:fileId', authenticate, requireRoles('seller', 'admin'), async (req, res, next) => {
  try {
    const product = await loadProduct(req);
    if (!product) return res.status(404).json({ message: 'Not found' });
    if (!isManager(req.user, product)) return res.status(403).json({ message: 'Forbidden' });
    const fileId = String(req.params.fileId || '');
    if (!mongoose.isValidObjectId(fileId)) return res.status(404).json({ message: 'File not found' });
    const file = await ContentEpisode.findOne({ _id: fileId, product: product._id });
    if (!file) return res.status(404).json({ message: 'File not found' });
    if (file.objectName && minio.isMinioEnabled()) {
      const cfg = await minio.ensurePlaygroundBucket();
      await minio.getMinioClient().removeObject(cfg.bucket, file.objectName).catch(() => undefined);
    }
    await file.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.isDownloadCategory = isDownloadCategory;
module.exports.safeFilename = safeFilename;
