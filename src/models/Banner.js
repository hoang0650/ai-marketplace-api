const mongoose = require('mongoose');

const LINK_TYPES = ['product', 'category', 'seller', 'url', 'agents', 'explore'];
const SLOTS = ['home_hero', 'offers', 'partners'];

const bannerSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    subtitle: { type: String, default: '', trim: true, maxlength: 200 },
    imageUrl: { type: String, required: true, trim: true },
    linkType: { type: String, enum: LINK_TYPES, required: true },
    linkValue: { type: String, default: '', trim: true },
    slot: { type: String, enum: SLOTS, required: true, index: true },
    sortOrder: { type: Number, default: 0, index: true },
    active: { type: Boolean, default: true, index: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
  },
  { timestamps: true },
);

bannerSchema.index({ slot: 1, active: 1, sortOrder: 1 });

bannerSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

bannerSchema.set('toJSON', { virtuals: true });
bannerSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Banner', bannerSchema);
module.exports.LINK_TYPES = LINK_TYPES;
module.exports.SLOTS = SLOTS;
