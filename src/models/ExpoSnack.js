const mongoose = require('mongoose');

/**
 * Cache of the Expo Snack published for an app template / Builder project, so the
 * "scan with Expo Go" QR only republishes when the files (or the target SDK) change.
 * key: `tpl:<productId>` or `prj:<projectId>`.
 */
const schema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, maxlength: 80 },
    hash: { type: String, default: '' },
    sdkVersion: { type: String, default: '' },
    snackId: { type: String, default: '' },
    url: { type: String, default: '' },
    savedAt: { type: Date, default: null },
    error: { type: String, default: '', maxlength: 300 },
    errorHash: { type: String, default: '' },
    errorAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ExpoSnack', schema);
