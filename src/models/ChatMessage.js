const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['text', 'image', 'file'], default: 'text' },
    attachments: {
      type: [
        new mongoose.Schema(
          {
            attachment: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment', required: true },
            name: { type: String, default: '' },
            mime: { type: String, default: '' },
            size: { type: Number, default: 0 },
            kind: { type: String, enum: ['image', 'file'], default: 'file' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    body: { type: String, default: '', maxlength: 2000 },
    imageUrl: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'chat_messages' },
);

chatMessageSchema.index({ conversation: 1, createdAt: 1 });
chatMessageSchema.index({ sender: 1, createdAt: -1 });

chatMessageSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
chatMessageSchema.set('toJSON', { virtuals: true });
chatMessageSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
