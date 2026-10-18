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

/** Reader bookmark / highlight (story-book): chapter + position, optional quoted text and note. */
const bookmarkSchema = new mongoose.Schema(
  {
    episode: { type: mongoose.Schema.Types.ObjectId, ref: 'ContentEpisode', required: true },
    fraction: { type: Number, default: 0, min: 0, max: 1 },
    page: { type: Number, default: 0, min: 0 },
    kind: { type: String, enum: ['bookmark', 'highlight'], default: 'bookmark' },
    quote: { type: String, default: '', maxlength: 600 },
    note: { type: String, default: '', maxlength: 1000 },
    color: { type: String, default: 'yellow', maxlength: 16 },
  },
  { timestamps: true }
);

/** Resume point: last episode and position watched / read per user and series. */
const watchProgressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    episode: { type: mongoose.Schema.Types.ObjectId, ref: 'ContentEpisode', required: true },
    positionSec: { type: Number, default: 0, min: 0 },
    /** Reader: scroll / page position inside the chapter (0..1) and page index for paged chapters. */
    fraction: { type: Number, default: 0, min: 0, max: 1 },
    page: { type: Number, default: 0, min: 0 },
    bookmarks: { type: [bookmarkSchema], default: [] },
  },
  { timestamps: true, collection: 'watch_progress' }
);
watchProgressSchema.index({ user: 1, product: 1 }, { unique: true });

const SeriesReaction = mongoose.models.SeriesReaction || mongoose.model('SeriesReaction', seriesReactionSchema);
const WatchProgress = mongoose.models.WatchProgress || mongoose.model('WatchProgress', watchProgressSchema);
module.exports = { SeriesReaction, WatchProgress };
