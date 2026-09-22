const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contextType: {
      type: String,
      enum: ['product', 'job', 'talent'],
      default: 'product',
      index: true,
    },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
    productName: { type: String, default: '' },
    productSlug: { type: String, default: '' },
    productCover: { type: String, default: '' },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPosting', default: null, index: true },
    jobTitle: { type: String, default: '' },
    jobSlug: { type: String, default: '' },
    talentSlug: { type: String, default: '' },
    lastMessage: { type: String, default: '' },
    lastKind: { type: String, enum: ['text', 'image'], default: 'text' },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    buyerUnread: { type: Number, default: 0, min: 0 },
    sellerUnread: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, collection: 'chat_conversations' },
);

/** Product threads (legacy + new) */
conversationSchema.index(
  { buyer: 1, seller: 1, product: 1 },
  { unique: true, partialFilterExpression: { product: { $type: 'objectId' } } },
);
/** Job threads: employer (seller) ↔ applicant (buyer) */
conversationSchema.index(
  { buyer: 1, seller: 1, job: 1 },
  { unique: true, partialFilterExpression: { job: { $type: 'objectId' } } },
);
/** Direct talent threads (no job) */
conversationSchema.index(
  { buyer: 1, seller: 1, contextType: 1, talentSlug: 1 },
  {
    unique: true,
    partialFilterExpression: { contextType: 'talent', talentSlug: { $type: 'string' } },
  },
);
conversationSchema.index({ seller: 1, lastMessageAt: -1 });
conversationSchema.index({ buyer: 1, lastMessageAt: -1 });

conversationSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
conversationSchema.set('toJSON', { virtuals: true });
conversationSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Conversation', conversationSchema);
