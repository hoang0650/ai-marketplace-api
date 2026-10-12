const mongoose = require('mongoose');

const LEGAL_DOCUMENT_TYPES = [
  'terms',
  'privacy',
  'marketplace-rules',
  'seller-policy',
  'buyer-policy',
  'payment-policy',
  'refund-policy',
  'dispute-policy',
  'complaint-policy',
  'intellectual-property',
  'acceptable-use',
  'data-policy',
  'seller-agreement',
  'tax-policy',
  'invoice-policy',
  'affiliate-policy',
];

const legalDocumentSchema = new mongoose.Schema(
  {
    documentType: {
      type: String,
      enum: LEGAL_DOCUMENT_TYPES,
      required: true,
      index: true,
    },
    version: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    locale: { type: String, default: 'vi', trim: true },
    /** Markdown or plain structured sections JSON string */
    content: { type: String, required: true },
    summary: { type: String, default: '' },
    effectiveAt: { type: Date, required: true },
    publishedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'published',
      index: true,
    },
  },
  { timestamps: true, collection: 'legal_documents' }
);

legalDocumentSchema.index({ documentType: 1, version: 1, locale: 1 }, { unique: true });

legalDocumentSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

legalDocumentSchema.set('toJSON', { virtuals: true });
legalDocumentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('LegalDocument', legalDocumentSchema);
module.exports.LEGAL_DOCUMENT_TYPES = LEGAL_DOCUMENT_TYPES;
