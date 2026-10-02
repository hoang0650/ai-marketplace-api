const mongoose = require('mongoose');

/**
 * AI App Builder project (rork-style): the buyer chats with their own provider key (BYOK)
 * and the model writes a static web app (`web`) or a React Native app (`app`).
 * Files are kept inline — projects are capped well below the 16 MB document limit.
 */
const fileSchema = new mongoose.Schema(
  {
    path: { type: String, required: true, maxlength: 120 },
    content: { type: String, default: '' },
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '', maxlength: 20000 },
    /** Paths the assistant wrote or deleted in this turn. */
    files: { type: [String], default: [] },
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const schema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: ['web', 'app'], required: true },
    provider: { type: String, default: '', trim: true, lowercase: true, maxlength: 40 },
    model: { type: String, default: '', trim: true, maxlength: 200 },
    files: { type: [fileSchema], default: [] },
    messages: { type: [messageSchema], default: [] },
    version: { type: Number, default: 0 },
    /** Unguessable capability for the public preview link (phones, sharing). */
    previewToken: { type: String, required: true },
    generating: { type: Boolean, default: false },
    lastGeneratedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ owner: 1, updatedAt: -1 });

module.exports = mongoose.model('BuilderProject', schema);
