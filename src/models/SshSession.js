const mongoose = require('mongoose');

const sshSessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    agentId: { type: String, default: 'openclaw', index: true },
    host: { type: String, required: true },
    port: { type: Number, default: 22 },
    username: { type: String, required: true },
    /** Plain password shown once at generation; stored for active session lookup */
    password: { type: String, required: true },
    command: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

sshSessionSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

sshSessionSchema.set('toJSON', { virtuals: true });
sshSessionSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('SshSession', sshSessionSchema);
