const mongoose = require('mongoose');

const WORK_STATUSES = [
  'none',
  'hired',
  'in_progress',
  'delivered',
  'revision_requested',
  'completed',
  'disputed',
  'cancelled',
];

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
    /** Lifecycle after hire (freelance delivery). */
    workStatus: {
      type: String,
      enum: WORK_STATUSES,
      default: 'none',
      index: true,
    },
    deliveryNote: { type: String, default: '', trim: true, maxlength: 4000 },
    deliveryUrls: { type: [String], default: [] },
    deliveredAt: { type: Date, default: null },
    revisionNote: { type: String, default: '', trim: true, maxlength: 2000 },
    revisionCount: { type: Number, default: 0, min: 0 },
    completedAt: { type: Date, default: null },
    disputedAt: { type: Date, default: null },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
  },
  { timestamps: true },
);

jobApplicationSchema.index({ job: 1, applicant: 1 }, { unique: true });
jobApplicationSchema.index({ job: 1, proposedAmount: 1, createdAt: -1 });
jobApplicationSchema.index({ applicant: 1, workStatus: 1, updatedAt: -1 });

jobApplicationSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
jobApplicationSchema.set('toJSON', { virtuals: true });
jobApplicationSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('JobApplication', jobApplicationSchema);
module.exports.WORK_STATUSES = WORK_STATUSES;
