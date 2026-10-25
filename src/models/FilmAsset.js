const mongoose = require('mongoose');

/** Reusable AI Film library entry: a character (face references) or a setting / location. */
const filmAssetSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['character', 'setting'], required: true },
  name: { type: String, required: true, maxlength: 60 },
  description: { type: String, default: '', maxlength: 400 },
  images: {
    type: [{ key: String, source: { type: String, enum: ['upload', 'generated'], default: 'upload' }, createdAt: { type: Date, default: Date.now }, _id: false }],
    default: [],
  },
  status: { type: String, enum: ['ready', 'generating', 'failed'], default: 'ready' },
}, { timestamps: true });
filmAssetSchema.index({ user: 1, type: 1, updatedAt: -1 });

module.exports = mongoose.models.FilmAsset || mongoose.model('FilmAsset', filmAssetSchema);
