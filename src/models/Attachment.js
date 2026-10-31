const mongoose = require('mongoose');

/** Private file shared inside a conversation or hire workspace. Bytes live in MinIO, never public. */
const attachmentSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scope: { type: String, enum: ['chat', 'hire', 'complaint', 'dispute'], required: true },
    scopeId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    objectName: { type: String, required: true },
    name: { type: String, required: true, maxlength: 200 },
    mime: { type: String, required: true, maxlength: 120 },
    size: { type: Number, required: true, min: 0 },
    kind: { type: String, enum: ['image', 'file'], required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'attachments' },
);

module.exports = mongoose.model('Attachment', attachmentSchema);
