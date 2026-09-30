const express = require('express');
const crypto = require('crypto');
const TrainingJob = require('../models/TrainingJob');
const GpuRental = require('../models/GpuRental');
const { authenticate } = require('../middleware/auth');
const svc = require('../utils/gpu-rental/service');
const { publicProvider, scrubVendor } = require('../utils/white-label');
const { sendError } = require('./gpu');

const router = express.Router();

/** Job status follows the billed workspace it runs on. */
function jobStatus(rental, current) {
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
      if (['succeeded', 'failed', 'cancelled'].includes(current)) return current;
      return rental.stoppedReason === 'insufficient_funds' ? 'failed' : 'cancelled';
    default:
      return current;
  }
}

function publicJob(doc, rental) {
  return {
    jobId: doc.jobId,
    modelId: doc.modelId,
    datasetId: doc.datasetId,
    provider: publicProvider(doc.provider),
    gpuType: rental?.gpuName || doc.gpuType,
    status: jobStatus(rental, doc.status),
    progress: doc.progress,
    logs: scrubVendor(doc.logs),
    cost: rental ? Math.round((rental.billedTotal || 0) * 100) / 100 : doc.cost,
    pricePerHour: rental?.pricePerHour ?? null,
    rentalId: rental ? String(rental._id) : null,
    artifact: doc.artifact,
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

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      sendError(res, next, err);
    }
  };
}

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
 * POST /v1/training-jobs — body { modelId, datasetId, offerId?, gpuCount?, volumeGb?, config? }
 * Runs on a prepaid GPU workspace billed per minute (same rules as /v1/gpu rentals).
 */
router.post(
  '/',
  authenticate,
  wrap(async (req, res) => {
    const body = req.body || {};
    const modelId = String(body.modelId || '').trim().slice(0, 200);
    const datasetId = String(body.datasetId || '').trim().slice(0, 200);
    const offerId = String(body.offerId || body.gpuType || '').trim() || (await defaultOfferId());
    const jobId = `tj_${crypto.randomBytes(8).toString('hex')}`;

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
    res.status(201).json(publicJob(doc, rental));
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

/** DELETE /v1/training-jobs/:jobId — cancel the job and release its GPU (final charge settles). */
router.delete(
  '/:jobId',
  authenticate,
  wrap(async (req, res) => {
    const doc = await TrainingJob.findOne({ jobId: req.params.jobId, buyer: req.user._id });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    let rental = doc.rental ? await GpuRental.findById(doc.rental) : null;
    if (rental) rental = await svc.terminateRental(rental);
    if (!['succeeded', 'failed'].includes(doc.status)) doc.status = 'cancelled';
    if (rental) doc.cost = Math.round((rental.billedTotal || 0) * 100) / 100;
    await doc.save();
    return res.json(publicJob(doc, rental));
  })
);

module.exports = router;
module.exports.jobStatus = jobStatus;
