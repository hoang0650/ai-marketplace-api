const mongoose = require('mongoose');

/**
 * A GPay Virtual Account (VND collection account) allocated to one user.
 * Deposits into `accountNumber` are reported via GPay's webhook and credited
 * to the user's USD wallet.
 */
const gpayVirtualAccountSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** GPay's account number customers transfer money into. */
    accountNumber: { type: String, required: true, unique: true, index: true },
    accountName: { type: String, default: '' },
    /** `map_id` sent to GPay — our stable reference for this user. */
    mapId: { type: String, required: true, index: true },
    mapType: { type: String, default: 'CUSTOMER_ID' },
    bankCode: { type: String, default: 'VCCB' },
    /** O = one-time (auto-closes after a transfer), M = multiple deposits. */
    accountType: { type: String, enum: ['O', 'M'], default: 'M' },
    status: { type: String, enum: ['pending', 'open', 'closed'], default: 'pending', index: true },
    balanceVnd: { type: Number, default: 0 },
    qrCode: { type: String, default: '' },
    /** Last GPay response, kept for debugging/reconciliation. */
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
    openedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'gpay_virtual_accounts' }
);

gpayVirtualAccountSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

gpayVirtualAccountSchema.set('toJSON', { virtuals: true });
gpayVirtualAccountSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('GpayVirtualAccount', gpayVirtualAccountSchema);
