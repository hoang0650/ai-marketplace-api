const mongoose = require('mongoose');

const terminalSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: String, default: 'default', index: true },
    server: { type: mongoose.Schema.Types.ObjectId, ref: 'GpuServer', required: true, index: true },
    provider: { type: String, default: 'runpod' },
    providerServerId: { type: String, required: true },
    status: {
      type: String,
      enum: ['starting', 'connected', 'disconnected', 'error'],
      default: 'starting',
      index: true,
    },
    lastActivityAt: { type: Date, default: Date.now },
    disconnectedAt: { type: Date, default: null },
    bytesIn: { type: Number, default: 0 },
    bytesOut: { type: Number, default: 0 },
    disconnectReason: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TerminalSession', terminalSessionSchema);
