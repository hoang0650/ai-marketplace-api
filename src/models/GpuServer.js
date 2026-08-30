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
  },
  { timestamps: true }
);

gpuServerSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
gpuServerSchema.set('toJSON', { virtuals: true });
gpuServerSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('GpuServer', gpuServerSchema);
