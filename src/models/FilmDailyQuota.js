const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: String, videos: { type: Number, default: 0 }, images: { type: Number, default: 0 },
  holds: { type: mongoose.Schema.Types.Mixed, default: {} }, expiresAt: Date,
}, { minimize: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.models.FilmDailyQuota || mongoose.model('FilmDailyQuota', schema);
