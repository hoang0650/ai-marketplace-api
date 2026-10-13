const mongoose = require('mongoose');

/** Audit trail of account deletions (in-app / signed-in web) and public web-form requests. */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    /** Only for public requests that still need identity verification; cleared once processed. */
    email: { type: String, default: '', lowercase: true, trim: true, maxlength: 200 },
    source: { type: String, enum: ['app', 'web', 'public_web'], required: true },
    status: { type: String, enum: ['pending', 'completed', 'rejected'], default: 'pending', index: true },
    reason: { type: String, default: '', maxlength: 1000 },
    requestedAt: { type: Date, default: Date.now },
    dueAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    retentionUntil: { type: Date, default: null },
    kycRetained: { type: Boolean, default: false },
    ip: { type: String, default: '' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AccountDeletionRequest', schema);
