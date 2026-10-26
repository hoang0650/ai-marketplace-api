const mongoose = require('mongoose');

const STATUSES = ['creating', 'active', 'deleted', 'error'];

/** A user's network volume (persistent /workspace that outlives pods in one data center). */
const gpuVolumeSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    dataCenterId: { type: String, required: true, trim: true, maxlength: 40 },
    sizeGb: { type: Number, required: true, min: 10 },
    /** Upstream volume id — internal only, never serialized to clients. */
    providerVolumeId: { type: String, default: '', index: true },
    status: { type: String, enum: STATUSES, default: 'creating', index: true },
    /** Upstream cost and locked sell price. */
    costPerGbMonth: { type: Number, default: 0 },
    pricePerGbMonth: { type: Number, default: 0 },
    pricePerHour: { type: Number, required: true, min: 0 },
    billedUntil: { type: Date, required: true },
    carry: { type: Number, default: 0 },
    billedMinutes: { type: Number, default: 0 },
    billedTotal: { type: Number, default: 0 },
    /** Set when the wallet cannot cover storage; the volume is deleted after this unless topped up. */
    terminateAfter: { type: Date, default: null, index: true },
    deletedAt: { type: Date, default: null },
    lastError: { type: String, default: '', maxlength: 120 },
  },
  { timestamps: true }
);

gpuVolumeSchema.index({ owner: 1, status: 1 });

gpuVolumeSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
gpuVolumeSchema.set('toJSON', { virtuals: true });
gpuVolumeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('GpuVolume', gpuVolumeSchema);
module.exports.GPU_VOLUME_STATUSES = STATUSES;
