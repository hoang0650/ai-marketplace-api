const express = require('express');
const mongoose = require('mongoose');
const TrainingDataset = require('../models/TrainingDataset');
const { authenticate } = require('../middleware/auth');
const minio = require('../config/minio');
const catalog = require('../utils/training/catalog');
const LicenseKey = require('../models/LicenseKey');
const Product = require('../models/Product');
const ContentEpisode = require('../models/ContentEpisode');
const { effectiveLicenseStatus } = require('../utils/license-keys');
const { findOwnActiveLicense } = require('../utils/online-access');
const { fetchSafeHttp } = require('../utils/safe-http-url');

const router = express.Router();

const UPLOAD_TTL_S = 3600;

const MESSAGES = {
  MINIO_NOT_CONFIGURED: 'Kho lưu trữ dữ liệu train chưa được cấu hình.',
  DATASET_NOT_FOUND: 'Không tìm thấy bộ dữ liệu.',
  FILE_NOT_FOUND: 'Không tìm thấy file.',
  TRAINING_SOURCE_INVALID: 'Loại dữ liệu không hợp lệ (raw, video hoặc audio).',
  TRANSCRIPT_TOO_LONG: 'Transcript tối đa 2000 ký tự mỗi file.',
  NAME_REQUIRED: 'Vui lòng đặt tên bộ dữ liệu.',
  DATASET_LIMIT: 'Bạn đã đạt số bộ dữ liệu tối đa. Hãy xóa bớt bộ cũ.',
  DATASET_FULL: 'Bộ dữ liệu đã đầy (số file hoặc dung lượng tối đa).',
  FILE_TYPE_NOT_ALLOWED: 'Định dạng file không được hỗ trợ cho loại dữ liệu này.',
  FILE_SIZE_REQUIRED: 'Thiếu dung lượng file.',
  FILE_TOO_LARGE: 'File vượt quá dung lượng cho phép.',
  UPLOAD_INCOMPLETE: 'File chưa được tải lên xong, vui lòng thử lại.',
  LABEL_INVALID: 'Nhãn chỉ gồm chữ, số, khoảng trắng, dấu gạch (tối đa 60 ký tự).',
  HF_DATASET_INVALID: 'Mã dataset Hugging Face không hợp lệ (dạng owner/name).',
  HF_DATASET_NOT_SUPPORTED: 'Chỉ dữ liệu thô mới dùng được dataset Hugging Face.',
  LICENSE_REQUIRED: 'Cần license còn hạn cho dataset này.',
  LICENSED_EMPTY: 'Người bán chưa tải file cho dataset này.',
  LICENSED_TOO_LARGE: 'Dataset vượt quá dung lượng cho phép để train.',
};

function sendError(res, next, err) {
  if (!err || !err.status || !err.code) return next(err);
  return res.status(err.status).json({
    message: MESSAGES[err.code] || err.code,
    code: err.code,
    ...(err.details || {}),
  });
}

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      sendError(res, next, err);
    }
  };
}

function requireMinio() {
  if (!minio.isMinioEnabled()) throw catalog.httpError(503, 'MINIO_NOT_CONFIGURED');
}

function publicFile(f) {
  return {
    id: String(f._id),
    filename: f.filename,
    contentType: f.contentType,
    size: f.size,
    label: f.label,
    transcript: f.transcript || '',
    role: f.role,
    status: f.status,
    createdAt: f.createdAt,
  };
}

function publicDataset(doc) {
  const files = doc.files || [];
  const ready = files.filter((f) => f.status === 'ready');
  return {
    id: String(doc._id),
    name: doc.name,
    source: doc.source,
    description: doc.description,
    hfDataset: doc.hfDataset,
    licensedProduct: doc.licensedProduct ? String(doc.licensedProduct) : null,
    labels: [...new Set(ready.map((f) => f.label).filter(Boolean))].sort(),
    fileCount: ready.length,
    transcribedCount: ready.filter((f) => f.transcript).length,
    totalBytes: ready.reduce((s, f) => s + (f.size || 0), 0),
    files: files.map(publicFile),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function findOwned(req) {
  const id = String(req.params.id || '');
  if (!mongoose.isValidObjectId(id)) throw catalog.httpError(404, 'DATASET_NOT_FOUND');
  const doc = await TrainingDataset.findOne({ _id: id, owner: req.user._id });
  if (!doc) throw catalog.httpError(404, 'DATASET_NOT_FOUND');
  return doc;
}

function findFile(doc, fileId) {
  const f = doc.files.id(String(fileId || ''));
  if (!f) throw catalog.httpError(404, 'FILE_NOT_FOUND');
  return f;
}

function cleanHf(value, source) {
  const hf = String(value || '').trim();
  if (!hf) return '';
  if (source !== 'raw') throw catalog.httpError(400, 'HF_DATASET_NOT_SUPPORTED');
  if (!catalog.HF_ID_RE.test(hf)) throw catalog.httpError(400, 'HF_DATASET_INVALID');
  return hf;
}

router.use(authenticate);

/** GET /v1/training-datasets?source=raw|video */
router.get(
  '/',
  wrap(async (req, res) => {
    const q = { owner: req.user._id };
    if (catalog.isSource(req.query.source)) q.source = req.query.source;
    const rows = await TrainingDataset.find(q).sort({ updatedAt: -1 }).limit(100);
    res.json({ datasets: rows.map(publicDataset), limits: catalog.limits(), tasks: catalog.TASKS });
  })
);

const LICENSED_DATASET = new Set(['dataset']);
const LICENSED_VOICE = new Set(['voice-clone', 'voice-preset']);

/** Active licenses of the caller, newest expiry first, one per product. */
async function activeLicenses(userId, categories) {
  const rows = await LicenseKey.find({ buyer: userId, category: { $in: categories } })
    .sort({ expiresAt: -1 })
    .limit(200)
    .lean();
  const out = new Map();
  for (const l of rows) {
    const pid = String(l.product);
    if (out.has(pid) || effectiveLicenseStatus(l) !== 'active') continue;
    out.set(pid, l);
  }
  return out;
}

function episodeFilename(e) {
  const base = String(e.title || `file-${e.index || 1}`).replace(/[^\w.\- ]+/g, '').trim().slice(0, 120) || `file-${e.index || 1}`;
  return base;
}

/**
 * GET /v1/training-datasets/licensed — datasets and voices the caller holds an active license for
 * (bought on the marketplace), so they can be used in training like Builder templates.
 */
router.get(
  '/licensed',
  wrap(async (req, res) => {
    const lic = await activeLicenses(req.user._id, [...LICENSED_DATASET, ...LICENSED_VOICE]);
    const ids = [...lic.keys()];
    const [products, episodes, imported] = await Promise.all([
      Product.find({ _id: { $in: ids } }).select('name slug category coverUrl contentMeta creatorName').lean(),
      ContentEpisode.find({ product: { $in: ids } }).select('product size kind').lean(),
      TrainingDataset.find({ owner: req.user._id, licensedProduct: { $in: ids } }).select('_id licensedProduct').lean(),
    ]);
    const files = new Map();
    for (const e of episodes) {
      const k = String(e.product);
      const f = files.get(k) || { count: 0, bytes: 0, kinds: new Set() };
      f.count += 1;
      f.bytes += e.size || 0;
      f.kinds.add(e.kind);
      files.set(k, f);
    }
    const importedBy = new Map(imported.map((d) => [String(d.licensedProduct), String(d._id)]));
    const datasets = [];
    const voices = [];
    for (const p of products) {
      const l = lic.get(String(p._id));
      const base = {
        productId: String(p._id),
        slug: p.slug,
        name: p.name,
        category: p.category,
        coverUrl: p.coverUrl || '',
        sellerName: p.creatorName || '',
        term: l.term,
        expiresAt: l.expiresAt,
      };
      if (LICENSED_DATASET.has(p.category)) {
        const f = files.get(String(p._id)) || { count: 0, bytes: 0, kinds: new Set() };
        datasets.push({ ...base, fileCount: f.count, totalBytes: f.bytes, importedDatasetId: importedBy.get(String(p._id)) || null });
      } else {
        const m = p.contentMeta || {};
        voices.push({
          ...base,
          voiceSource: m.voiceSource || (p.category === 'voice-preset' ? 'preset' : 'clone'),
          voiceModes: m.voiceModes || [],
          sampleUrl: m.voiceSampleUrl || '',
          ready: p.category === 'voice-preset' ? true : m.cloneStatus === 'ready',
        });
      }
    }
    const byExpiry = (a, b) => new Date(b.expiresAt) - new Date(a.expiresAt);
    res.json({ datasets: datasets.sort(byExpiry), voices: voices.sort(byExpiry) });
  })
);

/**
 * POST /v1/training-datasets/licensed/:productId/import — copy a licensed dataset's files into the
 * caller's private training storage once, so the normal training flow can use it. Idempotent.
 */
router.post(
  '/licensed/:productId/import',
  wrap(async (req, res) => {
    const pid = String(req.params.productId || '');
    if (!mongoose.isValidObjectId(pid)) throw catalog.httpError(404, 'DATASET_NOT_FOUND');
    const product = await Product.findById(pid).select('name category').lean();
    if (!product || !LICENSED_DATASET.has(product.category)) throw catalog.httpError(404, 'DATASET_NOT_FOUND');
    // Same owner-bound check as the online rows API. The copy stays in private training storage (no download
    // URL is ever exposed) and training jobs re-check the license before they start.
    const license = await findOwnActiveLicense({ userId: req.user._id, productId: pid });
    if (!license) throw catalog.httpError(402, 'LICENSE_REQUIRED');
    const existing = await TrainingDataset.findOne({ owner: req.user._id, licensedProduct: pid });
    if (existing) return res.json({ dataset: publicDataset(existing), imported: false });
    requireMinio();
    const episodes = await ContentEpisode.find({ product: pid }).sort({ index: 1 }).lean();
    const usable = episodes.filter((e) => e.objectName || e.sourceUrl);
    if (!usable.length) throw catalog.httpError(409, 'LICENSED_EMPTY');
    const lim = catalog.limits();
    if (usable.length > lim.maxFiles) throw catalog.httpError(413, 'LICENSED_TOO_LARGE');
    const count = await TrainingDataset.countDocuments({ owner: req.user._id });
    if (count >= lim.maxDatasets) throw catalog.httpError(409, 'DATASET_LIMIT');
    const allAudio = usable.every((e) => e.kind === 'audio');
    const doc = new TrainingDataset({
      owner: req.user._id,
      name: String(product.name || 'Dataset').slice(0, 80),
      source: allAudio ? 'audio' : 'raw',
      description: 'Từ dataset đã mua license trên AI Markets.',
      licensedProduct: pid,
    });
    let total = 0;
    for (const e of usable) {
      let buf;
      if (e.objectName) {
        const chunks = [];
        for await (const c of await minio.getContentObjectStream(e.objectName)) {
          chunks.push(c);
          total += c.length;
          if (total > lim.rawFileMaxBytes) throw catalog.httpError(413, 'LICENSED_TOO_LARGE');
        }
        buf = Buffer.concat(chunks);
      } else {
        const up = await fetchSafeHttp(e.sourceUrl, { timeoutMs: 60000, maxBytes: lim.rawFileMaxBytes, headers: { 'User-Agent': 'AI-Markets-Training/1.0' } });
        buf = up.buffer;
        total += buf.length;
        if (total > lim.rawFileMaxBytes) throw catalog.httpError(413, 'LICENSED_TOO_LARGE');
      }
      const filename = episodeFilename(e);
      const sub = doc.files.create({ objectName: 'pending', filename, contentType: e.contentType || 'application/octet-stream', size: buf.length, status: 'ready' });
      sub.objectName = minio.trainingObjectName(req.user._id, 'datasets', String(doc._id), `${sub._id}-${filename.replace(/\s+/g, '_')}`);
      await minio.putTrainingObject(sub.objectName, buf, sub.contentType);
      doc.files.push(sub);
    }
    await doc.save();
    res.status(201).json({ dataset: publicDataset(doc), imported: true });
  })
);

/** POST /v1/training-datasets — body { name, source: raw|video, description?, hfDataset? } */
router.post(
  '/',
  wrap(async (req, res) => {
    const body = req.body || {};
    const source = String(body.source || '');
    if (!catalog.isSource(source)) throw catalog.httpError(400, 'TRAINING_SOURCE_INVALID');
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) throw catalog.httpError(400, 'NAME_REQUIRED');
    const count = await TrainingDataset.countDocuments({ owner: req.user._id });
    if (count >= catalog.limits().maxDatasets) throw catalog.httpError(409, 'DATASET_LIMIT');
    const doc = await TrainingDataset.create({
      owner: req.user._id,
      name,
      source,
      description: String(body.description || '').trim().slice(0, 500),
      hfDataset: cleanHf(body.hfDataset, source),
    });
    res.status(201).json({ dataset: publicDataset(doc) });
  })
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    res.json({ dataset: publicDataset(await findOwned(req)) });
  })
);

router.patch(
  '/:id',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    const body = req.body || {};
    if (body.name !== undefined) {
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) throw catalog.httpError(400, 'NAME_REQUIRED');
      doc.name = name;
    }
    if (body.description !== undefined) doc.description = String(body.description || '').trim().slice(0, 500);
    if (body.hfDataset !== undefined) doc.hfDataset = cleanHf(body.hfDataset, doc.source);
    await doc.save();
    res.json({ dataset: publicDataset(doc) });
  })
);

/** DELETE /v1/training-datasets/:id — removes the stored files too (running jobs already copied theirs). */
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    const keys = doc.files.map((f) => f.objectName).filter((k) => minio.isTrainingObjectForUser(k, req.user._id));
    await minio.removeTrainingObjects(keys).catch(() => undefined);
    await doc.deleteOne();
    res.json({ ok: true });
  })
);

const hasLabels = (source) => source === 'video' || source === 'audio';

/**
 * POST /v1/training-datasets/:id/files — body { filename, size, contentType?, label?, role?, transcript? }
 * Returns a presigned PUT; the browser uploads straight to storage, then calls /complete.
 */
router.post(
  '/:id/files',
  wrap(async (req, res) => {
    requireMinio();
    const doc = await findOwned(req);
    const body = req.body || {};
    const { bytes } = catalog.checkUpload(doc.source, { filename: body.filename, size: body.size });
    const lim = catalog.limits();
    const used = doc.files.reduce((s, f) => s + (f.size || 0), 0);
    if (doc.files.length >= lim.maxFiles || used + bytes > lim.datasetMaxBytes) {
      throw catalog.httpError(409, 'DATASET_FULL', { maxFiles: lim.maxFiles, maxGb: Math.round(lim.datasetMaxBytes / 1024 ** 3) });
    }

    const filename = catalog.safeFilename(body.filename);
    const file = doc.files.create({
      objectName: 'pending',
      filename,
      contentType: String(body.contentType || '').slice(0, 120),
      size: bytes,
      label: hasLabels(doc.source) ? catalog.cleanLabel(body.label) : '',
      transcript: doc.source === 'audio' ? catalog.cleanTranscript(body.transcript) : '',
      role: doc.source === 'video' && body.role === 'reference' ? 'reference' : 'sample',
      status: 'pending',
    });
    file.objectName = minio.trainingObjectName(req.user._id, 'datasets', String(doc._id), `${file._id}-${filename}`);
    doc.files.push(file);
    await doc.save();

    const uploadUrl = await minio.presignTrainingPut(file.objectName, UPLOAD_TTL_S);
    res.status(201).json({
      file: publicFile(file),
      upload: { method: 'PUT', url: uploadUrl, expiresIn: UPLOAD_TTL_S },
    });
  })
);

/** POST /v1/training-datasets/:id/files/:fileId/complete — verifies the object landed in storage. */
router.post(
  '/:id/files/:fileId/complete',
  wrap(async (req, res) => {
    requireMinio();
    const doc = await findOwned(req);
    const file = findFile(doc, req.params.fileId);
    const st = await minio.statTrainingObject(file.objectName);
    if (!st || st.size <= 0) throw catalog.httpError(409, 'UPLOAD_INCOMPLETE');
    const max = catalog.fileMaxBytes(doc.source);
    if (st.size > max) {
      await minio.removeTrainingObjects([file.objectName]).catch(() => undefined);
      file.deleteOne();
      await doc.save();
      throw catalog.httpError(413, 'FILE_TOO_LARGE', { maxMb: Math.round(max / 1024 / 1024) });
    }
    file.size = st.size;
    if (st.contentType) file.contentType = st.contentType.slice(0, 120);
    file.status = 'ready';
    await doc.save();
    res.json({ file: publicFile(file), dataset: publicDataset(doc) });
  })
);

/** PATCH /v1/training-datasets/:id/files/:fileId — body { label?, role? (video), transcript? (audio) } */
router.patch(
  '/:id/files/:fileId',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    const file = findFile(doc, req.params.fileId);
    const body = req.body || {};
    if (hasLabels(doc.source) && body.label !== undefined) file.label = catalog.cleanLabel(body.label);
    if (doc.source === 'video' && body.role !== undefined) file.role = body.role === 'reference' ? 'reference' : 'sample';
    if (doc.source === 'audio' && body.transcript !== undefined) file.transcript = catalog.cleanTranscript(body.transcript);
    await doc.save();
    res.json({ file: publicFile(file), dataset: publicDataset(doc) });
  })
);

router.delete(
  '/:id/files/:fileId',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    const file = findFile(doc, req.params.fileId);
    if (minio.isTrainingObjectForUser(file.objectName, req.user._id)) {
      await minio.removeTrainingObjects([file.objectName]).catch(() => undefined);
    }
    file.deleteOne();
    await doc.save();
    res.json({ dataset: publicDataset(doc) });
  })
);

router._test = { activeLicenses };
module.exports = router;
module.exports.MESSAGES = MESSAGES;
module.exports.publicDataset = publicDataset;
