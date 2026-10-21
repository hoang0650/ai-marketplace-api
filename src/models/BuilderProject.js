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
    /** Seller template this project was started from (attribution; files are a copy). */
    template: {
      product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
      /** Seller of that template — only they may re-list a project built from it. */
      creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      name: { type: String, default: '', maxlength: 200 },
      version: { type: Number, default: 0 },
    },
    /** Buyer's own Git repository this project is pushed to (see routes/builder-git). */
    git: {
      provider: { type: String, default: '' },
      owner: { type: String, default: '', maxlength: 100 },
      repo: { type: String, default: '', maxlength: 100 },
      branch: { type: String, default: '', maxlength: 100 },
      repoUrl: { type: String, default: '', maxlength: 300 },
      private: { type: Boolean, default: true },
      lastCommitSha: { type: String, default: '' },
      lastCommitUrl: { type: String, default: '', maxlength: 400 },
      lastPushedAt: { type: Date, default: null },
      lastPushedVersion: { type: Number, default: 0 },
      /** Paths written by the last push; files removed in Builder are deleted from the repo next time. */
      pushedPaths: { type: [String], default: [] },
    },
    generating: { type: Boolean, default: false },
    lastGeneratedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ owner: 1, updatedAt: -1 });

// Cross-device sync: every saved change tells the owner's other devices to refetch.
schema.post('save', (doc) => {
  try {
    require('../realtime/user-bus').publish(doc.owner, 'project.updated', { id: String(doc._id), version: doc.version || 0, name: doc.name || '' });
  } catch {
    /* best effort */
  }
});

module.exports = mongoose.model('BuilderProject', schema);
