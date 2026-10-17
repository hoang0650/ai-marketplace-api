const mongoose = require('mongoose');

/** Per-user like / save on a film or story series (one row per user, product and kind). */
const seriesReactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    kind: { type: String, enum: ['like', 'save'], required: true },
  },
  { timestamps: true, collection: 'series_reactions' }
);
seriesReactionSchema.index({ user: 1, product: 1, kind: 1 }, { unique: true });

/** Resume point: last episode and position watched per user and series. */
const watchProgressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    episode: { type: mongoose.Schema.Types.ObjectId, ref: 'ContentEpisode', required: true },
    positionSec: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, collection: 'watch_progress' }
);
watchProgressSchema.index({ user: 1, product: 1 }, { unique: true });

const SeriesReaction = mongoose.models.SeriesReaction || mongoose.model('SeriesReaction', seriesReactionSchema);
const WatchProgress = mongoose.models.WatchProgress || mongoose.model('WatchProgress', watchProgressSchema);
module.exports = { SeriesReaction, WatchProgress };
