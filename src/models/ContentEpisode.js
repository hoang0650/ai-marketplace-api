const mongoose = require('mongoose');

const contentEpisodeSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    index: { type: Number, default: 1, min: 1 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    kind: {
      type: String,
      enum: ['video', 'image', 'audio', 'text'],
      required: true,
      index: true,
    },
    objectName: { type: String, default: '', maxlength: 500 },
    bucket: { type: String, default: '', maxlength: 120 },
    contentType: { type: String, default: '', maxlength: 120 },
    size: { type: Number, default: 0, min: 0 },
    durationSec: { type: Number, default: 0, min: 0 },
    /** Seed / remote original — never returned to buyers. Streamed only after license check. */
    sourceUrl: { type: String, default: '', maxlength: 800 },
    previewUrl: { type: String, default: '', maxlength: 800 },
    published: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, collection: 'content_episodes' }
);

contentEpisodeSchema.index({ product: 1, index: 1 });

contentEpisodeSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

contentEpisodeSchema.set('toJSON', { virtuals: true });
contentEpisodeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ContentEpisode', contentEpisodeSchema);
