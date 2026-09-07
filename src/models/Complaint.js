const mongoose = require('mongoose');

const KINDS = ['buyer_seller', 'buyer_platform', 'seller_platform'];
const STATUSES = [
  'received',
  'verifying',
  'classified',
  'awaiting_seller',
  'reviewing',
  'decided',
  'closed',
];
const DECISIONS = ['', 'upheld', 'rejected', 'mediated'];

const eventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String, default: '' },
    action: { type: String, required: true },
    note: { type: String, default: '', maxlength: 2000 },
  },
  { _id: false }
);

const complaintSchema = new mongoose.Schema(
  {
    caseRef: { type: String, default: '', index: true },
    complainant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    complainantName: { type: String, required: true, trim: true, maxlength: 200 },
    complainantEmail: { type: String, required: true, trim: true, maxlength: 200 },
    kind: { type: String, enum: KINDS, required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    productName: { type: String, default: '', maxlength: 300 },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    body: { type: String, required: true, maxlength: 4000 },
    requestedAction: { type: String, default: '', maxlength: 1000 },
    evidenceUrls: { type: [String], default: [] },
    status: { type: String, enum: STATUSES, default: 'received', index: true },
    sellerResponse: { type: String, default: '', maxlength: 4000 },
    sellerRespondedAt: { type: Date, default: null },
    decision: { type: String, enum: DECISIONS, default: '' },
    decisionNote: { type: String, default: '', maxlength: 2000 },
    decidedAt: { type: Date, default: null },
    appealReason: { type: String, default: '', maxlength: 2000 },
    appealedAt: { type: Date, default: null },
    openedOrderDispute: { type: Boolean, default: false },
    closedAt: { type: Date, default: null },
    events: { type: [eventSchema], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

complaintSchema.index({ complainant: 1, createdAt: -1 });
complaintSchema.index({ seller: 1, status: 1, createdAt: -1 });
complaintSchema.index({ status: 1, createdAt: -1 });

complaintSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

complaintSchema.set('toJSON', { virtuals: true });
complaintSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Complaint', complaintSchema);
module.exports.KINDS = KINDS;
module.exports.STATUSES = STATUSES;
module.exports.DECISIONS = DECISIONS;
