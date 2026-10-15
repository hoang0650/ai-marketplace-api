const mongoose = require('mongoose');

/** A browser or phone of a user, for "Thiết bị đã kết nối" and cross-device handoff. */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Random id generated and stored by the client (X-Device-Id). Only meaningful per user. */
    deviceId: { type: String, required: true, maxlength: 64 },
    name: { type: String, default: '', maxlength: 80 },
    platform: { type: String, enum: ['web', 'ios', 'android', 'other'], default: 'other' },
    linkedVia: { type: String, enum: ['handoff', 'session'], default: 'session' },
    lastActiveAt: { type: Date, default: Date.now },
    lastIp: { type: String, default: '', maxlength: 64 },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
schema.index({ user: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model('DeviceLink', schema);
