const mongoose = require('mongoose');

/**
 * One "Build" of a seller template from GitHub: the log the seller reads and, when it passed,
 * the checked files waiting to be published onto a template listing. Expires after a week.
 */
const fileSchema = new mongoose.Schema(
  {
    path: { type: String, required: true, maxlength: 120 },
    content: { type: String, default: '' },
  },
  { _id: false }
);

const logSchema = new mongoose.Schema(
  {
    t: { type: Number, default: 0 },
    level: { type: String, enum: ['info', 'warn', 'error', 'success'], default: 'info' },
    msg: { type: String, default: '' },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['web', 'app'], required: true },
    status: { type: String, enum: ['success', 'failed'], required: true },
    source: {
      provider: { type: String, enum: ['github'] },
      repo: String,
      branch: String,
      path: String,
      commitSha: String,
      commitMessage: String,
      repoUrl: String,
    },
    log: { type: [logSchema], default: [] },
    files: { type: [fileSchema], default: [] },
    skipped: { type: [{ path: String, reason: String, _id: false }], default: [] },
    durationMs: { type: Number, default: 0 },
    previewToken: { type: String, required: true },
    /** Listing the files were published to. */
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('TemplateBuild', schema);
