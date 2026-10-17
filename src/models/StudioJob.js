const mongoose = require('mongoose');

/** GPU studio job (fast video / talking avatar) proxied to the self-hosted GPU service. */
const studioJobSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['fast', 'talking', 'tts'], required: true },
    remoteId: { type: String, required: true },
    status: { type: String, enum: ['queued', 'running', 'succeeded', 'failed'], default: 'queued' },
    free: { type: Boolean, default: true },
    charged: { type: Number, default: 0 },
    walletTx: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTx', default: null },
    refunded: { type: Boolean, default: false },
    prompt: { type: String, default: '', maxlength: 1000 },
    lang: { type: String, default: '' },
    timings: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: '' },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);
studioJobSchema.index({ user: 1, kind: 1, createdAt: -1 });

module.exports = mongoose.models.StudioJob || mongoose.model('StudioJob', studioJobSchema);
