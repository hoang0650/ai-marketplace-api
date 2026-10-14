const mongoose = require('mongoose');

const sshSessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    agentId: { type: String, default: 'openclaw', index: true },
    host: { type: String, required: true },
    port: { type: Number, default: 22 },
    username: { type: String, required: true },
    /** `password` (OpenClaw/Hermes/NanoClaw) or `key` (SpaceBot sshd). */
    authMethod: { type: String, enum: ['password', 'key'], default: 'password' },
    /** Plain password shown once at generation; unset for key sessions. */
    password: { type: String, required: false },
    /**
     * scrypt hash of the password for isolated sandbox sessions (SSH gateway).
     * The plaintext is returned once at generation and never stored.
     */
    passwordHash: { type: String, required: false, select: false },
    /** True when the session logs in through the per-buyer sandbox gateway. */
    isolated: { type: Boolean, default: false, index: true },
    /** OpenSSH private key (PEM) for key-based sessions; required when authMethod=key. */
    privateKey: { type: String, required: false },
    /** Public key pushed to the agent's `authorized_keys`. */
    publicKey: { type: String, required: false },
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
