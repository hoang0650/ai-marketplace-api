const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const TrainingJob = require('../models/TrainingJob');
const TrainingDataset = require('../models/TrainingDataset');
const GpuRental = require('../models/GpuRental');
const { authenticate } = require('../middleware/auth');
const svc = require('../utils/gpu-rental/service');
const { gpuRentalConfig } = require('../utils/gpu-rental/config');
const minio = require('../config/minio');
const catalog = require('../utils/training/catalog');
const { findActiveLicense } = require('../utils/content-drm');
const bundle = require('../utils/training/bundle');
const { notifyUser } = require('../utils/notify');
const { publicProvider, scrubVendor } = require('../utils/white-label');
const { sendError: sendGpuError } = require('./gpu');

const router = express.Router();

const FINISHED = ['succeeded', 'failed', 'cancelled'];
const LOG_MAX = 16_000;
const METRICS_MAX = 8_000;
const ARTIFACT_PUT_TTL_S = 6 * 3600;
const ARTIFACT_GET_TTL_S = 3600;

const MESSAGES = {
  LICENSE_REQUIRED: 'License của dataset này đã hết hạn. Gia hạn để tiếp tục train.',
  MINIO_NOT_CONFIGURED: 'Kho lưu trữ dữ liệu train chưa được cấu hình.',
  DATASET_NOT_FOUND: 'Không tìm thấy bộ dữ liệu.',
  TRAINING_SOURCE_INVALID: 'Loại dữ liệu không hợp lệ (raw, video hoặc audio).',
  TRAINING_TASK_INVALID: 'Kiểu train không phù hợp với loại dữ liệu.',
  DATASET_SOURCE_MISMATCH: 'Bộ dữ liệu không đúng loại (thô / video) đã chọn.',
  DATASET_EMPTY: 'Bộ dữ liệu chưa có file nào đã tải lên xong.',
  DATASET_FILES_MISMATCH: 'Bộ dữ liệu không có file đúng định dạng cho kiểu train này.',
  HF_DATASET_INVALID: 'Mã dataset Hugging Face không hợp lệ (dạng owner/name).',
  HF_DATASET_NOT_SUPPORTED: 'Kiểu train này không dùng được dataset Hugging Face.',
  BASE_MODEL_REQUIRED: 'Vui lòng nhập base model (ví dụ Qwen/Qwen2.5-0.5B-Instruct).',
  BASE_MODEL_INVALID: 'Mã base model không hợp lệ (dạng owner/name trên Hugging Face).',
  LABELS_REQUIRED: 'Cần ít nhất 2 nhãn động tác khác nhau để train nhận diện.',
  VIDEO_LABEL_MISSING: 'Mỗi video cần gắn nhãn động tác trước khi train nhận diện.',
  REFERENCE_REQUIRED: 'Cần ít nhất 1 video mẫu chuẩn (reference) để chấm điểm động tác.',
  AUDIO_LABEL_MISSING: 'Mỗi file giọng nói cần gắn nhãn (người nói / lệnh / cảm xúc) trước khi train phân loại.',
  TRANSCRIPTS_REQUIRED: 'Cần nhập transcript (nội dung lời nói) cho các file giọng nói để train nhận dạng giọng nói.',
  JOB_TOKEN_INVALID: 'Job token không hợp lệ.',
  JOB_FINISHED: 'Job đã kết thúc.',
  ARTIFACT_NOT_READY: 'Model chưa sẵn sàng để tải.',
  ARTIFACT_INVALID: 'File model không hợp lệ.',
};

function sendError(res, next, err) {
  if (err && err.status && err.code && MESSAGES[err.code]) {
    return res.status(err.status).json({ message: MESSAGES[err.code], code: err.code, ...(err.details || {}) });
  }
  return sendGpuError(res, next, err);
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

/** Job status follows the billed workspace it runs on; results reported by the pod are final. */
function jobStatus(rental, current) {
  if (FINISHED.includes(current)) return current;
  if (!rental) return current;
  switch (rental.status) {
    case 'creating':
      return 'queued';
    case 'running':
      return 'running';
    case 'stopped':
      return 'paused';
    case 'error':
      return 'failed';
    case 'terminated':
      return rental.stoppedReason === 'insufficient_funds' ? 'failed' : 'cancelled';
    default:
      return current;
  }
}

function publicJob(doc, rental) {
  return {
    jobId: doc.jobId,
    source: doc.source || 'raw',
    task: doc.task || 'custom',
    modelId: doc.modelId,
    datasetId: doc.dataset ? String(doc.dataset) : doc.datasetId,
    datasetName: doc.datasetName || '',
    hfDataset: doc.hfDataset || '',
    provider: publicProvider(doc.provider),
    gpuType: rental?.gpuName || doc.gpuType,
    status: jobStatus(rental, doc.status),
    stage: doc.stage || '',
    progress: doc.progress,
    logs: scrubVendor(doc.logs),
    metrics: doc.metrics || {},
    config: doc.config || {},
    cost: rental ? Math.round((rental.billedTotal || 0) * 100) / 100 : doc.cost,
    pricePerHour: rental?.pricePerHour ?? null,
    rentalId: rental ? String(rental._id) : null,
    workspaceStatus: rental?.status || null,
    autoStop: doc.autoStop !== false,
    artifact: doc.artifactObject ? { size: doc.artifactSize || 0 } : null,
    finishedAt: doc.finishedAt,
    createdAt: doc.createdAt,
  };
}

async function syncJob(doc, rental) {
  if (!rental) return;
  const status = jobStatus(rental, doc.status);
  const cost = Math.round((rental.billedTotal || 0) * 100) / 100;
  if (status !== doc.status || cost !== doc.cost) {
    doc.status = status;
    doc.cost = cost;
    await doc.save();
  }
}

/** Cheapest offer with stock, used when the client does not pick a GPU. */
async function defaultOfferId() {
  const offers = await svc.publicOffers();
  const inStock = offers.filter((o) => o.availability !== 'unknown');
  const pool = inStock.length ? inStock : offers;
  pool.sort((a, b) => a.pricePerHour - b.pricePerHour);
  return pool[0]?.id || '';
}

/** /workspace sized for the dataset plus extracted features and checkpoints. */
function volumeFor(files, requested) {
  const cfg = gpuRentalConfig();
  const bytes = files.reduce((s, f) => s + (f.size || 0), 0);
  const needed = Math.ceil((bytes * 2.5) / 1024 ** 3) + 10;
  const ask = Number(requested) || 0;
  return Math.min(cfg.volumeGbMax, Math.max(ask, needed, cfg.volumeGbDefault));
}

async function loadDataset(user, datasetId) {
  const id = String(datasetId || '').trim();
  if (!id) return null;
  if (!mongoose.isValidObjectId(id)) throw catalog.httpError(404, 'DATASET_NOT_FOUND');
  const doc = await TrainingDataset.findOne({ _id: id, owner: user._id });
  if (!doc) throw catalog.httpError(404, 'DATASET_NOT_FOUND');
  // Imported from a marketplace license: train only while that license is still active.
  if (doc.licensedProduct && !(await findActiveLicense({ buyerId: user._id, productId: doc.licensedProduct }))) {
    throw catalog.httpError(402, 'LICENSE_REQUIRED');
  }
  return doc;
}

function tokenMatches(token, hash) {
  if (!token || !hash) return false;
  const a = Buffer.from(bundle.hashToken(token), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Pod-side calls authenticate with the per-job token, not a user session. */
async function jobFromToken(req) {
  const doc = await TrainingJob.findOne({ jobId: String(req.params.jobId || '') }).select('+reportTokenHash');
  if (!doc || !tokenMatches(String(req.get('x-job-token') || ''), doc.reportTokenHash)) {
    throw catalog.httpError(401, 'JOB_TOKEN_INVALID');
  }
  return doc;
}

function artifactPrefix(doc) {
  return minio.trainingObjectName(doc.buyer, 'jobs', doc.jobId, 'artifacts');
}

/** Applies one progress report from the pod. Returns true when the job just finished. */
function applyReport(doc, body = {}) {
  if (body.stage !== undefined) doc.stage = String(body.stage || '').replace(/[^\w-]+/g, '').slice(0, 40);
  if (body.progress !== undefined) {
    const p = Number(body.progress);
    if (Number.isFinite(p)) doc.progress = Math.min(100, Math.max(0, Math.round(p)));
  }
  if (typeof body.logs === 'string') doc.logs = body.logs.slice(-LOG_MAX);
  if (body.metrics && typeof body.metrics === 'object' && !Array.isArray(body.metrics)) {
    const json = JSON.stringify(body.metrics);
    if (json.length <= METRICS_MAX) doc.metrics = JSON.parse(json);
  }
  doc.lastReportAt = new Date();

  const status = String(body.status || '');
  if (status === 'running' && ['queued', 'paused'].includes(doc.status)) doc.status = 'running';
  if (status === 'succeeded' || status === 'failed') {
    doc.status = status;
    doc.finishedAt = new Date();
    if (status === 'succeeded') doc.progress = 100;
    return true;
  }
  return false;
}

async function finishJob(doc) {
  const rental = doc.rental ? await GpuRental.findById(doc.rental) : null;
  if (rental && doc.autoStop !== false && rental.status === 'running') {
    try {
      await svc.stopRental(rental, 'job_done');
    } catch {
      /* the billing worker still enforces balance; the buyer can stop it manually */
    }
  }
  if (rental) {
    doc.cost = Math.round((rental.billedTotal || 0) * 100) / 100;
    await doc.save();
  }
  const key = doc.status === 'succeeded' ? 'training.succeeded' : 'training.failed';
  await notifyUser(doc.buyer, key, { name: doc.datasetName || doc.modelId || doc.jobId }, '/training').catch(() => undefined);
}

// ---------- pod callbacks (job token) ----------

/** POST /v1/training-jobs/:jobId/report — body { status?, stage?, progress?, logs?, metrics?, artifact? } */
router.post(
  '/:jobId/report',
  wrap(async (req, res) => {
    const doc = await jobFromToken(req);
    if (FINISHED.includes(doc.status)) throw catalog.httpError(409, 'JOB_FINISHED');
    const body = req.body || {};
    if (body.artifact !== undefined) {
      const key = String(body.artifact || '');
      if (!key.startsWith(`${artifactPrefix(doc)}/`) || key.includes('..')) throw catalog.httpError(400, 'ARTIFACT_INVALID');
      const st = await minio.statTrainingObject(key);
      if (!st) throw catalog.httpError(400, 'ARTIFACT_INVALID');
      doc.artifactObject = key;
      doc.artifactSize = st.size;
    }
    const finished = applyReport(doc, body);
    await doc.save();
    if (finished) await finishJob(doc);
    res.json({ ok: true, status: doc.status });
  })
);

/** POST /v1/training-jobs/:jobId/artifact-url — body { filename } → presigned PUT for the model archive. */
router.post(
  '/:jobId/artifact-url',
  wrap(async (req, res) => {
    const doc = await jobFromToken(req);
    if (FINISHED.includes(doc.status)) throw catalog.httpError(409, 'JOB_FINISHED');
    const name = catalog.safeFilename(req.body?.filename || 'model.zip');
    const key = `${artifactPrefix(doc)}/${Date.now()}-${name}`;
    res.json({ objectName: key, method: 'PUT', url: await minio.presignTrainingPut(key, ARTIFACT_PUT_TTL_S) });
  })
);

// ---------- buyer API ----------

router.get(
  '/',
  authenticate,
  wrap(async (req, res) => {
    const rows = await TrainingJob.find({ buyer: req.user._id }).sort({ createdAt: -1 }).limit(50);
    const ids = rows.map((r) => r.rental).filter(Boolean);
    const rentals = ids.length ? await GpuRental.find({ _id: { $in: ids } }).lean() : [];
    const byId = new Map(rentals.map((r) => [String(r._id), r]));
    res.json(rows.map((doc) => publicJob(doc, doc.rental ? byId.get(String(doc.rental)) : null)));
  })
);

/**
 * POST /v1/training-jobs
 *   body { source: raw|video, task, datasetId?, hfDataset?, modelId?, config?, autoStop?, offerId?, gpuCount?, volumeGb? }
 * Legacy body { modelId, datasetId } (no source/task) keeps the old "empty workspace" behaviour.
 * Runs on a prepaid GPU workspace billed per minute (same rules as /v1/gpu rentals).
 */
router.post(
  '/',
  authenticate,
  wrap(async (req, res) => {
    const body = req.body || {};
    const offerId = String(body.offerId || body.gpuType || '').trim() || (await defaultOfferId());
    const jobId = `tj_${crypto.randomBytes(8).toString('hex')}`;

    if (!body.source && !body.task) {
      const modelId = String(body.modelId || '').trim().slice(0, 200);
      const datasetId = String(body.datasetId || '').trim().slice(0, 200);
      const rental = await svc.createRental(req.user, {
        offerId,
        name: `Training ${modelId || jobId}`.slice(0, 80),
        gpuCount: body.gpuCount,
        volumeGb: body.volumeGb,
      });
      const doc = await TrainingJob.create({
        jobId,
        buyer: req.user._id,
        modelId,
        datasetId,
        provider: 'runpod',
        gpuType: rental.offerId,
        status: jobStatus(rental, 'queued'),
        config: body.config && typeof body.config === 'object' ? body.config : {},
        rental: rental._id,
        logs: 'GPU workspace is starting. Open it from the GPU rentals page to run training.',
      });
      return res.status(201).json(publicJob(doc, rental));
    }

    const source = String(body.source || '');
    const task = String(body.task || '');
    if (!catalog.isSource(source)) throw catalog.httpError(400, 'TRAINING_SOURCE_INVALID');
    if (!minio.isMinioEnabled()) throw catalog.httpError(503, 'MINIO_NOT_CONFIGURED');
    const dataset = await loadDataset(req.user, body.datasetId);
    const plan = catalog.planJob({ source, task, dataset, hfDataset: body.hfDataset, modelId: body.modelId });
    const config = catalog.sanitizeConfig(task, body.config);
    const labels = [...new Set(plan.files.map((f) => f.label).filter(Boolean))].sort();
    const { token, hash } = bundle.newJobToken();

    const built = await bundle.buildJobBundle({
      userId: req.user._id,
      jobId,
      source,
      task,
      files: plan.files,
      modelId: plan.modelId,
      hfDataset: plan.hfDataset,
      config,
      labels,
    });

    // The job exists before the pod boots so its first progress report always finds it.
    const doc = await TrainingJob.create({
      jobId,
      buyer: req.user._id,
      source,
      task,
      modelId: plan.modelId,
      datasetId: dataset ? String(dataset._id) : '',
      dataset: dataset ? dataset._id : null,
      datasetName: dataset ? dataset.name : plan.hfDataset,
      hfDataset: plan.hfDataset,
      provider: 'runpod',
      status: 'queued',
      stage: 'provisioning',
      config,
      autoStop: body.autoStop !== false,
      reportTokenHash: hash,
      logs: 'Preparing the GPU workspace. Data and training scripts are copied automatically.',
    });

    let rental;
    try {
      rental = await svc.createRental(
        req.user,
        {
          offerId,
          name: `Train ${dataset ? dataset.name : task}`.slice(0, 80),
          gpuCount: body.gpuCount,
          volumeGb: volumeFor(plan.files, body.volumeGb),
        },
        {
          trainingEnv: {
            AIM_TRAINING_BOOTSTRAP_URL: built.bootstrapUrl,
            AIM_TRAINING_MANIFEST_URL: built.manifestUrl,
            AIM_JOB_TOKEN: token,
          },
        }
      );
    } catch (err) {
      await doc.deleteOne().catch(() => undefined);
      await minio.removeTrainingObjects(built.objects).catch(() => undefined);
      throw err;
    }

    doc.rental = rental._id;
    doc.gpuType = rental.offerId;
    doc.status = jobStatus(rental, 'queued');
    await doc.save();
    return res.status(201).json(publicJob(doc, rental));
  })
);

router.get(
  '/:jobId',
  authenticate,
  wrap(async (req, res) => {
    const doc = await TrainingJob.findOne({ jobId: req.params.jobId, buyer: req.user._id });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    let rental = doc.rental ? await GpuRental.findById(doc.rental) : null;
    if (rental) {
      rental = await svc.refreshRental(rental);
      await syncJob(doc, rental);
    }
    return res.json(publicJob(doc, rental));
  })
);

/** GET /v1/training-jobs/:jobId/artifact — short-lived download link for the trained model. */
router.get(
  '/:jobId/artifact',
  authenticate,
  wrap(async (req, res) => {
    const doc = await TrainingJob.findOne({ jobId: req.params.jobId, buyer: req.user._id });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    if (!doc.artifactObject || !minio.isMinioEnabled()) throw catalog.httpError(404, 'ARTIFACT_NOT_READY');
    const url = await minio.presignTrainingGet(doc.artifactObject, ARTIFACT_GET_TTL_S);
    return res.json({ url, expiresIn: ARTIFACT_GET_TTL_S, size: doc.artifactSize || 0 });
  })
);

/** DELETE /v1/training-jobs/:jobId — cancel the job and release its GPU (final charge settles). */
router.delete(
  '/:jobId',
  authenticate,
  wrap(async (req, res) => {
    const doc = await TrainingJob.findOne({ jobId: req.params.jobId, buyer: req.user._id });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    let rental = doc.rental ? await GpuRental.findById(doc.rental) : null;
    if (rental) rental = await svc.terminateRental(rental);
    if (!['succeeded', 'failed'].includes(doc.status)) {
      doc.status = 'cancelled';
      doc.finishedAt = doc.finishedAt || new Date();
    }
    if (rental) doc.cost = Math.round((rental.billedTotal || 0) * 100) / 100;
    await doc.save();
    return res.json(publicJob(doc, rental));
  })
);

module.exports = router;
module.exports.jobStatus = jobStatus;
module.exports.applyReport = applyReport;
module.exports.tokenMatches = tokenMatches;
module.exports.volumeFor = volumeFor;
module.exports.MESSAGES = MESSAGES;
