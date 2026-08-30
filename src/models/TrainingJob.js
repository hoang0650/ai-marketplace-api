const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    modelId: { type: String, default: '' },
    datasetId: { type: String, default: '' },
    provider: { type: String, required: true, default: 'runpod' },
    gpuType: { type: String, default: '' },
    status: {
      type: String,
      enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
      default: 'queued',
      index: true,
    },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    logs: { type: String, default: '' },
    cost: { type: Number, default: 0 },
    artifact: { type: String, default: '' },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    providerResourceId: { type: String, default: '' },
  },
  { timestamps: true }
);

schema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
schema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('TrainingJob', schema);
