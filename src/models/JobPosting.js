const mongoose = require('mongoose');

const jobPostingSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    company: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, required: true, maxlength: 8000 },
    location: { type: String, default: 'Remote', trim: true },
    remote: { type: Boolean, default: true },
    fieldIds: [{ type: String, trim: true }],
    skills: [{ type: String, trim: true }],
    employmentType: {
      type: String,
      enum: ['full-time', 'part-time', 'contract', 'freelance'],
      default: 'freelance',
    },
    salaryMin: { type: Number, default: 0 },
    salaryMax: { type: Number, default: 0 },
    salaryCurrency: { type: String, default: 'VND' },
    salaryPeriod: { type: String, enum: ['hour', 'month', 'project'], default: 'hour' },
    salaryNegotiable: { type: Boolean, default: false },
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    postedByName: { type: String, default: '', trim: true },
    applicationsCount: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

jobPostingSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

jobPostingSchema.set('toJSON', { virtuals: true });
jobPostingSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('JobPosting', jobPostingSchema);
