const mongoose = require('mongoose');

const usageStatSchema = new mongoose.Schema(
  {
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: String, required: true },
    tokens: { type: Number, default: 0 },
    gpuHours: { type: Number, default: 0 },
    requests: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
  },
  { timestamps: false }
);

usageStatSchema.index({ creator: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('UsageStat', usageStatSchema);
