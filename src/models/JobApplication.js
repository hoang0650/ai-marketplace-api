const mongoose = require('mongoose');

const jobApplicationSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPosting', required: true, index: true },
    applicant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    applicantName: { type: String, default: '', trim: true, maxlength: 120 },
    applicantAvatar: { type: String, default: '', trim: true },
    proposedAmount: { type: Number, default: 0, min: 0 },
    proposedCurrency: { type: String, default: 'VND', trim: true, maxlength: 8 },
    proposedPeriod: {
      type: String,
      enum: ['hour', 'day', 'week', 'month', 'project'],
      default: 'project',
    },
    coverLetter: { type: String, default: '', trim: true, maxlength: 2000 },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'withdrawn'],
      default: 'pending',
      index: true,
    },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
  },
  { timestamps: true },
);

jobApplicationSchema.index({ job: 1, applicant: 1 }, { unique: true });
jobApplicationSchema.index({ job: 1, proposedAmount: 1, createdAt: -1 });

jobApplicationSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
jobApplicationSchema.set('toJSON', { virtuals: true });
jobApplicationSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('JobApplication', jobApplicationSchema);
