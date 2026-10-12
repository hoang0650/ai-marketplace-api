const mongoose = require('mongoose');

/**
 * Commission owed to an affiliate for one order. Snapshot at order time; the net amount is
 * credited to the affiliate wallet immediately and frozen by the same 48h hold as seller sales.
 */
const affiliateCommissionSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    affiliate: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    productName: { type: String, default: '' },
    click: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliateClick', default: null },
    code: { type: String, default: '' },
    currency: { type: String, default: 'USD' },
    /** Order value the rate applies to: price after discount. */
    baseAmount: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0, max: 0.25 },
    amount: { type: Number, required: true, min: 0 },
    pitRate: { type: Number, default: 0 },
    pitAmount: { type: Number, default: 0 },
    pitRule: { type: String, default: '' },
    netAmount: { type: Number, required: true, min: 0 },
    holdUntil: { type: Date, required: true },
    status: { type: String, enum: ['active', 'reversed'], default: 'active', index: true },
    /** Net amount already clawed back (partial refunds). */
    reversedAmount: { type: Number, default: 0, min: 0 },
    reversedAt: { type: Date, default: null },
    reversalReason: { type: String, default: '' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AffiliateCommission', affiliateCommissionSchema);
