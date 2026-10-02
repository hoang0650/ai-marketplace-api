const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema(
  {
    objectName: { type: String, required: true },
    filename: { type: String, required: true, maxlength: 160 },
    contentType: { type: String, default: '', maxlength: 120 },
    size: { type: Number, default: 0, min: 0 },
    /** Video: the move performed (e.g. "Đấm thẳng"); audio: speaker / command / emotion class. */
    label: { type: String, default: '', maxlength: 60 },
    /** Audio: what is said in the clip (speech recognition target). */
    transcript: { type: String, default: '', maxlength: 2000 },
    /** Video: reference = the master performance other clips are scored against. */
    role: { type: String, enum: ['sample', 'reference'], default: 'sample' },
    /** pending until the browser finished the presigned upload and the API verified the object. */
    status: { type: String, enum: ['pending', 'ready'], default: 'pending' },
  },
  { timestamps: true }
);

const schema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    /** raw = prepared dataset files / HF id; video = footage of people performing; audio = voice recordings. */
    source: { type: String, enum: ['raw', 'video', 'audio'], required: true },
    description: { type: String, default: '', maxlength: 500 },
    /** Raw only: train straight from a Hugging Face dataset (owner/name). */
    hfDataset: { type: String, default: '', maxlength: 200 },
    files: { type: [fileSchema], default: [] },
  },
  { timestamps: true }
);

schema.virtual('readyBytes').get(function readyBytes() {
  return (this.files || []).filter((f) => f.status === 'ready').reduce((s, f) => s + (f.size || 0), 0);
});

module.exports = mongoose.model('TrainingDataset', schema);
