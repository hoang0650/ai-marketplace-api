const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  productSlug: { type: String, default: '' }, model: { type: String, default: '' },
  status: { type: String, enum: ['RUNNING', 'COMPLETED', 'FAILED', 'RECORDED'], default: 'RUNNING' },
  legacyEvent: { type: mongoose.Schema.Types.ObjectId, unique: true, sparse: true },
  request: mongoose.Schema.Types.Mixed, response: mongoose.Schema.Types.Mixed,
  executionMs: { type: Number, default: 0 }, delayMs: { type: Number, default: 0 },
  cost: { type: Number, default: 0 }, usage: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ owner: 1, product: 1, createdAt: -1 });
schema.index({ owner: 1, createdAt: -1 });
module.exports = mongoose.model('InferenceRequest', schema);
