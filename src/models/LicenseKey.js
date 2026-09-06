const mongoose = require('mongoose');

const licenseKeySchema = new mongoose.Schema(
  {
    licenseKey: { type: String, required: true, unique: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    productName: { type: String, default: '' },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: { type: String, default: '' },
    term: { type: String, enum: ['day', 'month', 'year'], required: true },
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['active', 'expired', 'revoked'],
      default: 'active',
      index: true,
    },
    lastValidatedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'license_keys' }
);

licenseKeySchema.index({ buyer: 1, createdAt: -1 });
licenseKeySchema.index({ product: 1, buyer: 1 });

licenseKeySchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

licenseKeySchema.set('toJSON', { virtuals: true });
licenseKeySchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('LicenseKey', licenseKeySchema);
