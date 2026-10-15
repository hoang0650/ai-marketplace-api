const mongoose = require('mongoose');

const STATUSES = ['requested', 'quoted', 'active', 'completed', 'terminated', 'declined', 'cancelled'];
const MILESTONE_STATUSES = ['pending', 'in_progress', 'submitted', 'approved', 'cancelled'];

const fileRefSchema = new mongoose.Schema(
  {
    attachment: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment', required: true },
    name: { type: String, default: '' },
    mime: { type: String, default: '' },
    size: { type: Number, default: 0 },
    kind: { type: String, enum: ['image', 'file'], default: 'file' },
  },
  { _id: false },
);

const quoteSchema = new mongoose.Schema(
  {
    amount: { type: Number, default: 0, min: 0 },
    note: { type: String, default: '', maxlength: 2000 },
    by: { type: String, enum: ['seller', 'buyer', ''], default: '' },
    at: { type: Date, default: null },
  },
  { _id: false },
);

const milestoneSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    amount: { type: Number, required: true, min: 0 },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: MILESTONE_STATUSES, default: 'pending' },
    /** Seller's AI Markets Builder project used as the live demo (build web / app). */
    builderProject: { type: mongoose.Schema.Types.ObjectId, ref: 'BuilderProject', default: null },
    demoUrl: { type: String, default: '', maxlength: 500 },
    demoNote: { type: String, default: '', maxlength: 4000 },
    /** Deliverable files for this phase (private attachments). */
    files: { type: [fileRefSchema], default: [] },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    revisionNote: { type: String, default: '', maxlength: 2000 },
    revisionCount: { type: Number, default: 0 },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  },
  { _id: true },
);

const eventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    actor: { type: String, enum: ['buyer', 'seller', 'admin', 'system'], required: true },
    action: { type: String, required: true },
    note: { type: String, default: '', maxlength: 2000 },
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    actor: { type: String, enum: ['buyer', 'seller', 'admin', 'system'], required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    body: { type: String, default: '', maxlength: 4000 },
    attachments: { type: [fileRefSchema], default: [] },
    link: { type: String, default: '', maxlength: 500 },
  },
  { _id: true },
);

const hireProjectSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    productName: { type: String, required: true, maxlength: 300 },
    productSlug: { type: String, default: '' },
    category: { type: String, required: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    buyerName: { type: String, default: '' },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sellerName: { type: String, default: '' },
    brief: { type: String, required: true, maxlength: 6000 },
    budget: { type: Number, default: 0, min: 0 },
    desiredDeadline: { type: Date, default: null },
    currency: { type: String, default: 'USD' },
    listPrice: { type: Number, default: 0 },
    quote: { type: quoteSchema, default: () => ({}) },
    status: { type: String, enum: STATUSES, default: 'requested', index: true },
    milestones: { type: [milestoneSchema], default: [] },
    acceptedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    terminatedAt: { type: Date, default: null },
    terminationReason: { type: String, enum: ['', 'late', 'not_as_requested', 'other'], default: '' },
    terminationNote: { type: String, default: '', maxlength: 4000 },
    complaint: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', default: null },
    events: { type: [eventSchema], default: [] },
    /** Order workspace chat between buyer and seller. */
    messages: { type: [messageSchema], default: [] },
    /** 'package' = fixed-price professional service split into phases; 'quote' = legacy flow. */
    origin: { type: String, enum: ['quote', 'package'], default: 'quote' },
  },
  { timestamps: true },
);

hireProjectSchema.index({ buyer: 1, updatedAt: -1 });
hireProjectSchema.index({ seller: 1, updatedAt: -1 });

module.exports = mongoose.model('HireProject', hireProjectSchema);
module.exports.STATUSES = STATUSES;
module.exports.MILESTONE_STATUSES = MILESTONE_STATUSES;
