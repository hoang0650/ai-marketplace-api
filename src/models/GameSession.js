const mongoose = require('mongoose');

/** Live game/desktop stream session. Internal host/port never sent to the browser. */
const gameSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: String, default: 'default' },
    server: { type: mongoose.Schema.Types.ObjectId, ref: 'GpuServer', required: true, index: true },
    provider: { type: String, default: 'runpod' },
    providerServerId: { type: String, required: true },
    status: { type: String, enum: ['starting', 'live', 'stopped', 'error'], default: 'starting' },
    streamKind: { type: String, default: 'sandbox' },
    streamHost: { type: String, default: '' },
    streamPort: { type: Number, default: 0 },
    streamPath: { type: String, default: '/' },
    streamTls: { type: Boolean, default: false },
    lastActivityAt: { type: Date, default: Date.now },
    stoppedAt: { type: Date, default: null },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    /** Buyer client: pc = web/desktop, android / ios = mobile app. */
    client: { type: String, enum: ['pc', 'android', 'ios'], default: 'pc' },
    device: { type: String, enum: ['pc', 'mobile'], default: 'pc', index: true },
    /** aimarkets = platform-paid RunPod pod; external = seller-hosted machine. */
    hosting: { type: String, default: '' },
    billingStartedAt: { type: Date, default: null },
    /** Per-minute billing cursor (compare-and-set by the worker) and sub-cent remainder. */
    billedUntil: { type: Date, default: null },
    billingCarry: { type: Number, default: 0, min: 0 },
    billedCost: { type: Number, default: 0, min: 0 },
    billedMinutes: { type: Number, default: 0, min: 0 },
    /** Set once the client sends heartbeats; only then is the idle timeout enforced. */
    heartbeatAt: { type: Date, default: null },
    lowBalanceWarnedAt: { type: Date, default: null },
    stopReason: { type: String, default: '' },
    /** Dedicated game server: one pod per session, torn down on stop. */
    dedicated: { type: Boolean, default: false, index: true },
    /** Upstream pod cost and the buyer rate derived from it (USD/hour). */
    podCostPerHour: { type: Number, default: 0, min: 0 },
    ratePerHour: { type: Number, default: 0, min: 0 },
    game: { type: String, default: '' },
    connectHost: { type: String, default: '' },
    connectPort: { type: Number, default: 0 },
    privatePort: { type: Number, default: 0 },
    readyAt: { type: Date, default: null },
    podTerminatedAt: { type: Date, default: null },
    launchError: { type: String, default: '' },
  },
  { timestamps: true }
);

gameSessionSchema.index({ status: 1, billedUntil: 1 });

module.exports = mongoose.model('GameSession', gameSessionSchema);
