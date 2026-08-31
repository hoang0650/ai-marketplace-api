const mongoose = require('mongoose');

const gpuServerSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: String, default: 'default', index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    provider: { type: String, default: 'runpod', index: true },
    providerServerId: { type: String, required: true, index: true },
    kind: { type: String, enum: ['compute', 'game'], default: 'compute', index: true },
    status: { type: String, default: 'creating', index: true },
    gpu: { type: String, default: '' },
    /** Linked marketplace product (external seller nodes). */
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
    external: { type: Boolean, default: false, index: true },
    /** Seller webhook — session.start / session.stop */
    webhookUrl: { type: String, default: '', trim: true, maxlength: 500 },
    webhookSecret: { type: String, default: '', trim: true, maxlength: 256 },
    /** Static stream upstream (internal; proxied — never exposed to browser). */
    streamKind: { type: String, default: '', trim: true },
    streamHost: { type: String, default: '', trim: true },
    streamPort: { type: Number, default: 0, min: 0 },
    streamPath: { type: String, default: '/', trim: true },
    streamTls: { type: Boolean, default: false },
    iframeUrl: { type: String, default: '', trim: true, maxlength: 500 },
    healthUrl: { type: String, default: '', trim: true, maxlength: 500 },
    region: { type: String, default: '', trim: true, maxlength: 80 },
    maxConcurrent: { type: Number, default: 10, min: 1 },
  },
  { timestamps: true }
);

gpuServerSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
gpuServerSchema.set('toJSON', { virtuals: true });
gpuServerSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('GpuServer', gpuServerSchema);
