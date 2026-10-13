const mongoose = require('mongoose');

/**
 * One VAT invoice record per order (NĐ 123/2020, amended by NĐ 70/2025): an invoice is issued for
 * every sale. When the buyer does not want one, it is issued without buyer details and the buyer
 * name reads "Người mua không lấy hóa đơn".
 */
const orderInvoiceSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    productName: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    orderedAt: { type: Date, default: null },

    wantsInvoice: { type: Boolean, default: false, index: true },
    buyerType: { type: String, enum: ['none', 'organization', 'individual'], default: 'none' },
    buyerName: { type: String, default: 'Người mua không lấy hóa đơn', maxlength: 300 },
    taxCode: { type: String, default: '', maxlength: 20 },
    /** Individuals: personal tax code or CCCD/ID number (NĐ 70/2025 allows the personal identifier). */
    personalId: { type: String, default: '', maxlength: 20 },
    address: { type: String, default: '', maxlength: 500 },
    email: { type: String, default: '', maxlength: 200 },
    /** Organizations: optional buyer unit code / budget-related unit code (mã ĐVQHNS). */
    budgetUnitCode: { type: String, default: '', maxlength: 20 },

    /** Buyer may change the choice until the end of the purchase day (VN time) while pending. */
    editableUntil: { type: Date, default: null },
    status: { type: String, enum: ['pending', 'issued', 'cancelled'], default: 'pending', index: true },
    invoiceNumber: { type: String, default: '', maxlength: 50 },
    invoiceSeries: { type: String, default: '', maxlength: 20 },
    lookupCode: { type: String, default: '', maxlength: 100 },
    pdfObjectName: { type: String, default: '' },
    issuedAt: { type: Date, default: null },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** E-invoice provider hook: 'manual' today; a provider adapter fills providerRef later. */
    provider: { type: String, default: 'manual' },
    providerRef: { type: String, default: '' },
    choiceUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.models.OrderInvoice || mongoose.model('OrderInvoice', orderInvoiceSchema);
