const mongoose = require('mongoose');

const walletTxSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['credit', 'debit', 'withdraw', 'deposit'], required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    note: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

walletTxSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

walletTxSchema.set('toJSON', { virtuals: true });
walletTxSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('WalletTx', walletTxSchema);
