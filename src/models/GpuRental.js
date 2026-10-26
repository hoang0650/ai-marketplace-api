const mongoose = require('mongoose');

const STATUSES = ['creating', 'running', 'stopped', 'terminated', 'error'];

const gpuRentalSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    offerId: { type: String, required: true, trim: true },
    gpuName: { type: String, default: '', trim: true },
    gpuMemoryGb: { type: Number, default: 0 },
    gpuCount: { type: Number, default: 1, min: 1, max: 8 },
    diskGb: { type: Number, default: 20 },
    volumeGb: { type: Number, default: 20 },
    /** secure | community (RunPod cloud). Network volumes are secure-only. */
    cloudType: { type: String, enum: ['secure', 'community'], default: 'secure' },
    /** Attached network volume (mounted at /workspace); the pod is pinned to its data center. */
    volume: { type: mongoose.Schema.Types.ObjectId, ref: 'GpuVolume', default: null, index: true },
    dataCenterId: { type: String, default: '', trim: true, maxlength: 40 },
    /** Upstream pod id — internal only, never serialized to clients. */
    providerServerId: { type: String, default: '', index: true },
    status: { type: String, enum: STATUSES, default: 'creating', index: true },
    ready: { type: Boolean, default: false },
    /** Upstream cost (USD/hour) and locked sell prices (USD/hour). */
    costPerHour: { type: Number, default: 0 },
    pricePerHour: { type: Number, required: true, min: 0 },
    stoppedPricePerHour: { type: Number, default: 0, min: 0 },
    /** Billing cursor: everything before this instant is already charged. */
    billedUntil: { type: Date, required: true },
    /** Sub-cent remainder carried to the next charge so the ledger stays in cents. */
    carry: { type: Number, default: 0 },
    billedMinutes: { type: Number, default: 0 },
    billedTotal: { type: Number, default: 0 },
    lowBalanceWarnedAt: { type: Date, default: null },
    stoppedReason: { type: String, enum: ['', 'user', 'insufficient_funds', 'admin', 'job_done'], default: '' },
    stoppedAt: { type: Date, default: null },
    terminateAfter: { type: Date, default: null, index: true },
    terminatedAt: { type: Date, default: null },
    /** Jupyter server token — injected by our proxy, never sent to the browser. */
    accessToken: { type: String, default: '', select: false },
    lastError: { type: String, default: '', maxlength: 120 },
  },
  { timestamps: true }
);

gpuRentalSchema.index({ status: 1, billedUntil: 1 });

gpuRentalSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
gpuRentalSchema.set('toJSON', { virtuals: true });
gpuRentalSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('GpuRental', gpuRentalSchema);
module.exports.GPU_RENTAL_STATUSES = STATUSES;
