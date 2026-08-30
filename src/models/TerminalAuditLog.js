const mongoose = require('mongoose');

const terminalAuditLogSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: String, default: 'default' },
    serverId: { type: String, default: '' },
    event: { type: String, required: true },
    errorCode: { type: String, default: '' },
    meta: { type: Object, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('TerminalAuditLog', terminalAuditLogSchema);
