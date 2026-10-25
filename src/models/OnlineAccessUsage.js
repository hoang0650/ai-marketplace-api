const mongoose = require('mongoose');

/**
 * Per-license usage buckets for online-only products (dataset rows, skill runs, film/story playback).
 * One document per (scope, kind, window); TTL removes old buckets automatically.
 */
const schema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    scope: { type: String, required: true, index: true },
    kind: { type: String, required: true },
    window: { type: String, enum: ['m', 'd'], required: true },
    requests: { type: Number, default: 0 },
    units: { type: Number, default: 0 },
    expireAt: { type: Date, required: true },
  },
  { timestamps: false, collection: 'online_access_usage' }
);
schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.OnlineAccessUsage || mongoose.model('OnlineAccessUsage', schema);
