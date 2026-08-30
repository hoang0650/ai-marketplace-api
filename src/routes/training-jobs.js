const express = require('express');
const crypto = require('crypto');
const TrainingJob = require('../models/TrainingJob');
const { authenticate } = require('../middleware/auth');
const provider = require('../utils/denglish-providers');

const router = express.Router();

function publicJob(doc) {
  return {
    jobId: doc.jobId,
    modelId: doc.modelId,
    datasetId: doc.datasetId,
    provider: doc.provider,
    gpuType: doc.gpuType,
    status: doc.status,
    progress: doc.progress,
    logs: doc.logs,
    cost: doc.cost,
    artifact: doc.artifact,
    createdAt: doc.createdAt,
  };
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const rows = await TrainingJob.find({ buyer: req.user._id }).sort({ createdAt: -1 }).limit(50);
    res.json(rows.map(publicJob));
  } catch (e) {
    next(e);
  }
});

router.post('/', authenticate, async (req, res, next) => {
  try {
    const providerName = String(req.body?.provider || 'runpod').toLowerCase();
    const jobId = `tj_${crypto.randomBytes(8).toString('hex')}`;
    const doc = await TrainingJob.create({
      jobId,
      buyer: req.user._id,
      modelId: String(req.body?.modelId || ''),
      datasetId: String(req.body?.datasetId || ''),
      provider: providerName,
      gpuType: String(req.body?.gpuType || ''),
      status: 'queued',
      config: req.body?.config || {},
    });
    try {
      const remote = await provider.createProviderServer(providerName, {
        name: `train-${jobId}`,
        kind: 'compute',
        gpuType: doc.gpuType,
      });
      doc.providerResourceId = remote?.server?.id || '';
      doc.status = 'running';
      doc.progress = 5;
      doc.logs = 'Training container requested via provider adapter.';
      await doc.save();
    } catch (err) {
      doc.status = 'queued';
      doc.logs = String(err.message || 'Provider not ready — job queued.');
      await doc.save();
    }
    res.status(201).json(publicJob(doc));
  } catch (e) {
    next(e);
  }
});

router.get('/:jobId', authenticate, async (req, res, next) => {
  try {
    const doc = await TrainingJob.findOne({ jobId: req.params.jobId, buyer: req.user._id });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json(publicJob(doc));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
