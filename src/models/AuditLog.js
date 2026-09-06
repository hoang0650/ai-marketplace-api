const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorRole: { type: String, default: '' },
    action: { type: String, required: true, index: true },
    resourceType: { type: String, required: true, index: true },
    resourceId: { type: String, default: '', index: true },
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    reason: { type: String, default: '', maxlength: 1000 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_logs' }
);

auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
