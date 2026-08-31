const mongoose = require('mongoose');

const talentProfileSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', sparse: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    avatarUrl: { type: String, default: '' },
    bio: { type: String, default: '', maxlength: 2000 },
    fieldIds: [{ type: String, trim: true }],
    skills: [{ type: String, trim: true }],
    experienceYears: { type: Number, default: 0 },
    hoursPerWeek: { type: Number, default: 40 },
    rateAmount: { type: Number, default: 0 },
    rateCurrency: { type: String, default: 'VND' },
    rateNegotiable: { type: Boolean, default: true },
    available: { type: Boolean, default: true, index: true },
    contractsCount: { type: Number, default: 0 },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    reviewsCount: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

talentProfileSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

talentProfileSchema.set('toJSON', { virtuals: true });
talentProfileSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('TalentProfile', talentProfileSchema);
