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
    billingStartedAt: { type: Date, default: null },
    billedCost: { type: Number, default: 0, min: 0 },
    billedMinutes: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GameSession', gameSessionSchema);
