const mongoose = require('mongoose');

const legalAcceptanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    documentType: { type: String, required: true, index: true },
    version: { type: String, required: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalDocument', default: null },
    acceptedAt: { type: Date, default: Date.now },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    context: {
      type: String,
      enum: ['register', 'seller_onboarding', 'checkout', 'manual'],
      default: 'manual',
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'legal_acceptances' }
);

legalAcceptanceSchema.index({ user: 1, documentType: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('LegalAcceptance', legalAcceptanceSchema);
