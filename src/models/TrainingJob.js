const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    /** raw = prepared dataset / HF id; video = real-world footage → pose keypoints; audio = voice clips. */
    source: { type: String, enum: ['raw', 'video', 'audio'], default: 'raw' },
    /** Recipe run on the pod (see utils/training/catalog.js). Legacy jobs are "custom". */
    task: { type: String, default: 'custom' },
    modelId: { type: String, default: '' },
    datasetId: { type: String, default: '' },
    dataset: { type: mongoose.Schema.Types.ObjectId, ref: 'TrainingDataset', default: null },
    datasetName: { type: String, default: '' },
    hfDataset: { type: String, default: '' },
    provider: { type: String, required: true, default: 'runpod' },
    gpuType: { type: String, default: '' },
    reusedRental: { type: Boolean, default: false },
    rentalBilledStart: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'],
      default: 'queued',
      index: true,
    },
    /** Pipeline step reported by the pod: downloading, pose, training, uploading, ready… */
    stage: { type: String, default: '' },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    logs: { type: String, default: '' },
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    cost: { type: Number, default: 0 },
    artifact: { type: String, default: '' },
    /** Private MinIO key of the trained model archive. */
    artifactObject: { type: String, default: '' },
    artifactSize: { type: Number, default: 0 },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Stop the workspace (keeps /workspace) once the recipe finishes. */
    autoStop: { type: Boolean, default: true },
    /** sha256 of the per-job token the pod uses to report progress. */
    reportTokenHash: { type: String, default: '', select: false },
    lastReportAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    providerResourceId: { type: String, default: '' },
    /** Shared AI Markets RTX 5090: ran during the free launch promo (no wallet charge). */
    freePromo: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    /** Billed GPU workspace the job runs on (per-minute wallet billing). */
    rental: { type: mongoose.Schema.Types.ObjectId, ref: 'GpuRental', default: null, index: true },
  },
  { timestamps: true }
);

schema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
schema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('TrainingJob', schema);
