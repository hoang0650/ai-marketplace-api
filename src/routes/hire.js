const express = require('express');
const mongoose = require('mongoose');
const HireProject = require('../models/HireProject');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Complaint = require('../models/Complaint');
const BuilderProject = require('../models/BuilderProject');
const { authenticate } = require('../middleware/auth');
const { notifyUser } = require('../utils/notify');
const { isCatalogVisible } = require('../utils/moderation');
const { canOpenDispute } = require('../utils/payout-hold');
const { openOrderDispute } = require('../utils/open-order-dispute');
const { caseRefFromId, notifyAdmins, auditComplaint } = require('../utils/complaint-helpers');
const { writeAuditLog } = require('../utils/audit');
const { chargeMilestone } = require('../finance/milestone-sale');
const { resolveAttachments, mapEmbedded } = require('./attachments');
const { publicProject: publicBuilderProject } = require('./builder');
const {
  BUILDER_DEMO_KIND,
  httpError,
  isHireRequestCategory,
  parseAmount,
  normalizeMilestones,
  roleIn,
  currentMilestone,
  isOverdue,
  assertAction,
  advanceAfterApproval,
  cancelOpenMilestones,
  paidTotal,
  packageMilestones,
} = require('../utils/hire/rules');

const router = express.Router();

const MESSAGES = {
  AMOUNT_INVALID: 'Số tiền không hợp lệ.',
  BRIEF_REQUIRED: 'Hãy mô tả yêu cầu (ít nhất 20 ký tự).',
  NOTE_REQUIRED: 'Hãy ghi rõ lý do (ít nhất 8 ký tự).',
  HIRE_PRODUCT_INVALID: 'Listing này không nhận yêu cầu thuê theo dự án.',
  HIRE_OWN_PRODUCT: 'Bạn không thể gửi yêu cầu cho listing của chính mình.',
  HIRE_ALREADY_OPEN: 'Bạn đã có một yêu cầu đang mở với listing này.',
  HIRE_TOO_MANY: 'Bạn có quá nhiều yêu cầu đang mở.',
  HIRE_NOT_FOUND: 'Không tìm thấy dự án thuê.',
  HIRE_FORBIDDEN: 'Bạn không thuộc dự án này.',
  HIRE_ACTION_NOT_ALLOWED: 'Không thể thực hiện thao tác này ở trạng thái hiện tại.',
  HIRE_NOT_NEGOTIABLE: 'Listing này không nhận thương lượng giá.',
  HIRE_BUSY: 'Đang xử lý thao tác trước, thử lại sau giây lát.',
  HIRE_NOT_OVERDUE: 'Giai đoạn hiện tại chưa quá hạn.',
  MILESTONES_REQUIRED: 'Cần ít nhất 1 giai đoạn.',
  MILESTONES_TOO_MANY: 'Tối đa 10 giai đoạn.',
  MILESTONE_AMOUNT_INVALID: 'Số tiền mỗi giai đoạn phải lớn hơn 0.',
  MILESTONE_DUE_INVALID: 'Hạn giai đoạn không hợp lệ.',
  MILESTONE_DUE_PAST: 'Hạn giai đoạn 1 phải ở tương lai.',
  MILESTONE_DUE_ORDER: 'Hạn của mỗi giai đoạn phải sau giai đoạn trước.',
  MILESTONES_SUM_MISMATCH: 'Tổng tiền các giai đoạn phải bằng giá đã thống nhất.',
  DEMO_BUILDER_REQUIRED: 'Hãy chọn project AI App Builder của bạn để khách xem demo trực tiếp trên AI Markets.',
  DEMO_REQUIRED: 'Hãy gửi link demo hoặc mô tả kết quả bàn giao.',
  DEMO_URL_INVALID: 'Link demo phải là https://.',
  BUILDER_PROJECT_INVALID: 'Project Builder không tồn tại hoặc không thuộc về bạn.',
  INSUFFICIENT_WALLET: 'Số dư ví không đủ để nghiệm thu giai đoạn này. Hãy nạp thêm.',
  PAYOUT_HELD: 'Số dư khả dụng không đủ (một phần đang bị tạm giữ 48h).',
  SERVICE_PRICE_REQUIRED: 'Gói dịch vụ chưa có giá cố định.',
  MESSAGE_REQUIRED: 'Tin nhắn trống.',
  COMPLAINT_OPEN: 'Dự án này đã có khiếu nại đang xử lý.',
};

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (!err || !err.status || !err.code) return next(err);
      return res
        .status(err.status)
        .json({ code: err.code, message: MESSAGES[err.code] || err.message, ...(err.extra || {}), ...(err.body || {}) });
    }
  };
}

function isId(v) {
  return mongoose.isValidObjectId(v);
}

function cleanText(v, max) {
  return String(v || '').trim().slice(0, max);
}

function httpsUrl(raw) {
  const s = cleanText(raw, 500);
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') throw new Error('protocol');
    return u.toString();
  } catch {
    throw httpError(400, 'DEMO_URL_INVALID');
  }
}

function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

function publicHire(doc, me, previews = new Map(), now = new Date()) {
  const o = doc.toObject ? doc.toObject() : doc;
  const role = roleIn(o, me);
  const cur = currentMilestone(o);
  return {
    id: String(o._id),
    role,
    status: o.status,
    productId: String(o.product),
    productName: o.productName,
    productSlug: o.productSlug || '',
    category: o.category,
    buyerId: String(o.buyer),
    buyerName: o.buyerName || '',
    sellerId: String(o.seller),
    sellerName: o.sellerName || '',
    brief: o.brief,
    budget: o.budget || 0,
    desiredDeadline: iso(o.desiredDeadline),
    currency: o.currency || 'USD',
    listPrice: o.listPrice || 0,
    quote: {
      amount: o.quote?.amount || 0,
      note: o.quote?.note || '',
      by: o.quote?.by || '',
      at: iso(o.quote?.at),
    },
    demoKind: BUILDER_DEMO_KIND[o.category] || null,
    milestones: (o.milestones || []).map((m, i) => {
      const preview = m.builderProject ? previews.get(String(m.builderProject)) : null;
      return {
        id: String(m._id),
        index: i,
        title: m.title,
        amount: m.amount,
        dueAt: iso(m.dueAt),
        status: m.status,
        overdue: isOverdue(m, now),
        builderProjectId: m.builderProject ? String(m.builderProject) : null,
        previewUrl: preview?.previewUrl || '',
        previewKind: preview?.kind || null,
        demoUrl: m.demoUrl || '',
        demoNote: m.demoNote || '',
        files: mapEmbedded(m.files),
        submittedAt: iso(m.submittedAt),
        approvedAt: iso(m.approvedAt),
        revisionNote: m.revisionNote || '',
        revisionCount: m.revisionCount || 0,
        orderId: m.order ? String(m.order) : null,
      };
    }),
    currentMilestoneId: cur ? String(cur._id) : null,
    paidTotal: paidTotal(o),
    acceptedAt: iso(o.acceptedAt),
    completedAt: iso(o.completedAt),
    terminatedAt: iso(o.terminatedAt),
    terminationReason: o.terminationReason || '',
    terminationNote: o.terminationNote || '',
    complaintId: o.complaint ? String(o.complaint) : null,
    events: (o.events || []).map((e) => ({ at: iso(e.at), actor: e.actor, action: e.action, note: e.note || '' })),
    messages: (o.messages || []).map((m) => ({ id: String(m._id), at: iso(m.at), actor: m.actor, body: m.body || '', link: m.link || '', attachments: mapEmbedded(m.attachments) })),
    origin: o.origin || 'quote',
    createdAt: iso(o.createdAt),
    updatedAt: iso(o.updatedAt),
  };
}

async function previewsFor(docs) {
  const ids = [];
  for (const d of docs) for (const m of d.milestones || []) if (m.builderProject) ids.push(m.builderProject);
  if (!ids.length) return new Map();
  const projects = await BuilderProject.find({ _id: { $in: ids } }).select('name kind previewToken').lean();
  return new Map(projects.map((p) => [String(p._id), publicBuilderProject(p)]));
}

async function loadForUser(req) {
  if (!isId(req.params.id)) throw httpError(404, 'HIRE_NOT_FOUND');
  const doc = await HireProject.findById(req.params.id);
  if (!doc) throw httpError(404, 'HIRE_NOT_FOUND');
  const role = roleIn(doc, req.user._id);
  if (!role && req.user.role !== 'admin') throw httpError(403, 'HIRE_FORBIDDEN');
  return { doc, role };
}

async function respond(res, doc, me, status = 200) {
  const previews = await previewsFor([doc]);
  res.status(status).json(publicHire(doc, me, previews));
}

function pushEvent(doc, actor, action, note = '') {
  doc.events.push({ at: new Date(), actor, action, note: cleanText(note, 2000) });
}

const href = (doc) => `/hire/projects/${doc._id}`;

/** Files a buyer→seller complaint for the project; freezes the latest paid phase if still in its 48h hold. */
/** The project's complaint if it is still being handled (not decided/closed), else null. */
async function openComplaintOf(doc) {
  if (!doc.complaint) return null;
  const c = await Complaint.findById(doc.complaint);
  return c && !['decided', 'closed'].includes(c.status) ? c : null;
}

async function fileComplaint(req, doc, { note, requestedAction, context }) {
  const lastPaid = [...(doc.milestones || [])].reverse().find((m) => m.status === 'approved' && m.order);
  const order = lastPaid ? await Order.findById(lastPaid.order) : null;
  let opened = false;
  if (order && canOpenDispute(order)) {
    await openOrderDispute(order, { reason: note, actorName: req.user.name, href: '/sell/complaints' });
    opened = true;
  }
  const complaint = await Complaint.create({
    complainant: req.user._id,
    complainantName: req.user.name || 'Buyer',
    complainantEmail: req.user.email || 'unknown@aimarkets.vn',
    kind: 'buyer_seller',
    order: order ? order._id : null,
    product: doc.product,
    productName: order ? order.productName : doc.productName,
    seller: doc.seller,
    hireProject: doc._id,
    body: note,
    requestedAction: cleanText(requestedAction, 1000) || 'Xem xét dự án dịch vụ và hoàn tiền giai đoạn liên quan (nếu có).',
    // Seller must be able to answer (POST /complaints/:id/seller-response requires awaiting_seller).
    status: 'awaiting_seller',
    openedOrderDispute: opened,
    events: [
      {
        at: new Date(),
        actorId: req.user._id,
        actorRole: req.user.role,
        action: 'received',
        note: `${context}${opened ? ' Order payout frozen (48h dispute).' : ''}`,
      },
    ],
  });
  complaint.caseRef = caseRefFromId(complaint._id);
  await complaint.save();
  doc.complaint = complaint._id;
  await notifyUser(doc.seller, 'complaint.new', { text: note.slice(0, 280) }, `/sell/complaints/${complaint._id}`).catch(() => {});
  await notifyUser(complaint.complainant, 'complaint.received', { caseRef: complaint.caseRef }, `/complaints/${complaint._id}`).catch(() => {});
  await notifyAdmins('complaint.newAdmin', { kind: 'buyer_seller' }, `/admin/complaints/${complaint._id}`).catch(() => {});
  await auditComplaint(req, 'complaint.create', complaint).catch(() => {});
  return complaint;
}

/** One approve/accept at a time per project (single API process). */
const busy = new Set();
async function withLock(id, fn) {
  const key = String(id);
  if (busy.has(key)) throw httpError(409, 'HIRE_BUSY');
  busy.add(key);
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}

router.use(authenticate);

router.get(
  '/projects',
  wrap(async (req, res) => {
    const as = String(req.query.as || '');
    const uid = req.user._id;
    const filter = as === 'buyer' ? { buyer: uid } : as === 'seller' ? { seller: uid } : { $or: [{ buyer: uid }, { seller: uid }] };
    const docs = await HireProject.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
    const previews = await previewsFor(docs);
    res.json(docs.map((d) => publicHire(d, uid, previews)));
  }),
);

router.get(
  '/projects/:id',
  wrap(async (req, res) => {
    const { doc } = await loadForUser(req);
    await respond(res, doc, req.user._id);
  }),
);

router.post(
  '/projects',
  wrap(async (req, res) => {
    const body = req.body || {};
    if (!isId(body.productId)) throw httpError(400, 'HIRE_PRODUCT_INVALID');
    const product = await Product.findById(body.productId).lean();
    if (!product || !isCatalogVisible(product) || !isHireRequestCategory(product.category)) {
      throw httpError(400, 'HIRE_PRODUCT_INVALID');
    }
    if (String(product.creator) === String(req.user._id)) throw httpError(400, 'HIRE_OWN_PRODUCT');
    const brief = cleanText(body.brief, 6000);
    if (brief.length < 20) throw httpError(400, 'BRIEF_REQUIRED');
    const open = { $in: ['requested', 'quoted', 'active'] };
    const existing = await HireProject.findOne({ buyer: req.user._id, product: product._id, status: open }).select('_id').lean();
    if (existing) throw httpError(409, 'HIRE_ALREADY_OPEN', { projectId: String(existing._id) });
    if ((await HireProject.countDocuments({ buyer: req.user._id, status: open })) >= 20) throw httpError(429, 'HIRE_TOO_MANY');

    const budget = Number(body.budget) > 0 ? parseAmount(body.budget) : 0;
    const deadline = body.desiredDeadline ? new Date(body.desiredDeadline) : null;
    const doc = await HireProject.create({
      product: product._id,
      productName: product.name,
      productSlug: product.slug,
      category: product.category,
      buyer: req.user._id,
      buyerName: req.user.name || '',
      seller: product.creator,
      sellerName: product.creatorName || '',
      brief,
      budget,
      desiredDeadline: deadline && !Number.isNaN(deadline.getTime()) ? deadline : null,
      currency: product.pricing?.currency || 'USD',
      listPrice: Number(product.pricing?.price) || 0,
      status: 'requested',
      events: [{ actor: 'buyer', action: 'requested', note: budget ? `budget ${budget}` : '' }],
    });
    await notifyUser(product.creator, 'hire.requested', { buyer: req.user.name, product: product.name }, href(doc)).catch(() => {});
    await respond(res, doc, req.user._id, 201);
  }),
);

router.post(
  '/projects/:id/quote',
  wrap(async (req, res) => {
    const { doc, role } = await loadForUser(req);
    assertAction(doc, role, 'quote');
    const amount = parseAmount(req.body?.amount);
    doc.quote = { amount, note: cleanText(req.body?.note, 2000), by: 'seller', at: new Date() };
    doc.status = 'quoted';
    pushEvent(doc, 'seller', 'quoted', `${amount} ${doc.currency}`);
    await doc.save();
    await notifyUser(
      doc.buyer,
      'hire.quoted',
      { seller: doc.sellerName, amount, currency: doc.currency, product: doc.productName },
      href(doc),
    ).catch(() => {});
    await respond(res, doc, req.user._id);
  }),
);

router.post(
  '/projects/:id/counter',
  wrap(async (req, res) => {
    const { doc, role } = await loadForUser(req);
    assertAction(doc, role, 'counter');
    const product = await Product.findById(doc.product).select('pricing').lean();
    if (product?.pricing && product.pricing.negotiable === false) throw httpError(400, 'HIRE_NOT_NEGOTIABLE');
    const amount = parseAmount(req.body?.amount);
    doc.quote = { amount, note: cleanText(req.body?.note, 2000), by: 'buyer', at: new Date() };
    doc.budget = amount;
    doc.status = 'requested';
    pushEvent(doc, 'buyer', 'countered', `${amount} ${doc.currency}`);
    await doc.save();
    await notifyUser(
      doc.seller,
      'hire.countered',
      { buyer: doc.buyerName, amount, currency: doc.currency, product: doc.productName },
      href(doc),
    ).catch(() => {});
    await respond(res, doc, req.user._id);
  }),
);

router.post(
  '/projects/:id/decline',
  wrap(async (req, res) => {
    const { doc, role } = await loadForUser(req);
    assertAction(doc, role, 'decline');
    doc.status = 'declined';
    pushEvent(doc, 'seller', 'declined', req.body?.note);
    await doc.save();
    await notifyUser(doc.buyer, 'hire.declined', { seller: doc.sellerName, product: doc.productName, note: cleanText(req.body?.note, 300) }, href(doc)).catch(() => {});
    await respond(res, doc, req.user._id);
  }),
);

router.post(
  '/projects/:id/cancel',
  wrap(async (req, res) => {
    const { doc, role } = await loadForUser(req);
    assertAction(doc, role, 'cancel');
    doc.status = 'cancelled';
    pushEvent(doc, 'buyer', 'cancelled', req.body?.note);
    await doc.save();
    await notifyUser(doc.seller, 'hire.cancelled', { buyer: doc.buyerName, product: doc.productName }, href(doc)).catch(() => {});
    await respond(res, doc, req.user._id);
  }),
);

router.post(
  '/projects/:id/accept',
  wrap(async (req, res) => {
    const { doc, role } = await loadForUser(req);
    assertAction(doc, role, 'accept');
    doc.milestones = normalizeMilestones(req.body?.milestones, { total: doc.quote.amount });
    doc.status = 'active';
    doc.acceptedAt = new Date();
    pushEvent(doc, 'buyer', 'accepted', `${doc.quote.amount} ${doc.currency} · ${doc.milestones.length}`);
    await doc.save();
    await notifyUser(
      doc.seller,
      'hire.accepted',
      { buyer: doc.buyerName, amount: doc.quote.amount, currency: doc.currency, product: doc.productName, count: doc.milestones.length },
      href(doc),
    ).catch(() => {});
    await respond(res, doc, req.user._id);
  }),
);

router.post(
  '/projects/:id/submit',
  wrap(async (req, res) => {
    const { doc, role } = await loadForUser(req);
    assertAction(doc, role, 'submit');
    const m = currentMilestone(doc);
    const kind = BUILDER_DEMO_KIND[doc.category];
    const note = cleanText(req.body?.note, 4000);
    const demoUrl = httpsUrl(req.body?.demoUrl);
    let builderProject = null;
    if (req.body?.builderProjectId) {
      if (!isId(req.body.builderProjectId)) throw httpError(400, 'BUILDER_PROJECT_INVALID');
      const bp = await BuilderProject.findOne({ _id: req.body.builderProjectId, owner: req.user._id }).select('_id kind').lean();
      if (!bp || (kind && bp.kind !== kind)) throw httpError(400, 'BUILDER_PROJECT_INVALID');
      builderProject = bp._id;
    }
    const files = await resolveAttachments(req.body?.attachmentIds, { scope: 'hire', scopeId: doc._id, owner: req.user._id });
    if (kind && !builderProject) throw httpError(400, 'DEMO_BUILDER_REQUIRED');
    if (!kind && !demoUrl && !files.length && note.length < 8) throw httpError(400, 'DEMO_REQUIRED');
    m.files = files;
    m.builderProject = builderProject;
    m.demoUrl = demoUrl;
    m.demoNote = note;
    m.submittedAt = new Date();
    m.status = 'submitted';
    const phase = doc.milestones.indexOf(m) + 1;
    pushEvent(doc, 'seller', 'submitted', `#${phase}`);
    await doc.save();
    await notifyUser(doc.buyer, 'hire.submitted', { seller: doc.sellerName, phase, product: doc.productName }, href(doc)).catch(() => {});
    await respond(res, doc, req.user._id);
  }),
);

router.post(
  '/projects/:id/revision',
  wrap(async (req, res) => {
    const { doc, role } = await loadForUser(req);
    assertAction(doc, role, 'revision');
    const note = cleanText(req.body?.note, 2000);
    if (note.length < 8) throw httpError(400, 'NOTE_REQUIRED');
    const m = currentMilestone(doc);
    m.status = 'in_progress';
    m.revisionNote = note;
    m.revisionCount = (m.revisionCount || 0) + 1;
    const phase = doc.milestones.indexOf(m) + 1;
    pushEvent(doc, 'buyer', 'revision', `#${phase}`);
    await doc.save();
    await notifyUser(doc.seller, 'hire.revision', { phase, product: doc.productName, note }, href(doc)).catch(() => {});
    await respond(res, doc, req.user._id);
  }),
);

router.post(
  '/projects/:id/approve',
  wrap(async (req, res) => {
    const { doc: loaded, role } = await loadForUser(req);
    assertAction(loaded, role, 'approve');
    await withLock(loaded._id, async () => {
      const doc = await HireProject.findById(loaded._id);
      assertAction(doc, role, 'approve');
      const m = currentMilestone(doc);
      const index = doc.milestones.indexOf(m);
      const product = await Product.findById(doc.product);
      if (!product) throw httpError(404, 'HIRE_PRODUCT_INVALID');
      const { order, settlement } = await chargeMilestone({ project: doc, milestone: m, index, product, buyer: req.user });
      const done = advanceAfterApproval(doc, { orderId: order._id });
      pushEvent(doc, 'buyer', 'approved', `#${index + 1} · order ${order._id}`);
      if (done) pushEvent(doc, 'system', 'completed');
      await doc.save();
      if (done) await Product.updateOne({ _id: product._id }, { $inc: { salesCount: 1 } });
      await notifyUser(
        doc.seller,
        'hire.approved',
        { phase: index + 1, product: doc.productName, amount: settlement.sellerNetAmount, currency: doc.currency },
        href(doc),
      ).catch(() => {});
      await notifyUser(
        doc.buyer,
        'hire.charged',
        { phase: index + 1, product: doc.productName, amount: order.amount, currency: order.currency },
        href(doc),
      ).catch(() => {});
      if (done) {
        await notifyUser(doc.seller, 'hire.completed', { product: doc.productName }, href(doc)).catch(() => {});
        await notifyUser(doc.buyer, 'hire.completed', { product: doc.productName }, href(doc)).catch(() => {});
      }
      await writeAuditLog({
        actorId: req.user._id,
        actorRole: req.user.role,
        action: 'HIRE_MILESTONE_APPROVED',
        resourceType: 'HireProject',
        resourceId: doc._id,
        newValue: { milestone: index, orderId: String(order._id), amount: order.amount, currency: order.currency },
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
      }).catch(() => {});
      await respond(res, doc, req.user._id);
    });
  }),
);

router.post(
  '/projects/:id/terminate',
  wrap(async (req, res) => {
    const { doc, role } = await loadForUser(req);
    assertAction(doc, role, 'terminate');
    const reason = ['late', 'not_as_requested', 'other'].includes(req.body?.reason) ? req.body.reason : 'other';
    const note = cleanText(req.body?.note, 4000);
    if (note.length < 8) throw httpError(400, 'NOTE_REQUIRED');
    if (reason === 'late' && !isOverdue(currentMilestone(doc))) throw httpError(409, 'HIRE_NOT_OVERDUE');

    const lastApproved = cancelOpenMilestones(doc);
    doc.status = 'terminated';
    doc.terminatedAt = new Date();
    doc.terminationReason = reason;
    doc.terminationNote = note;
    pushEvent(doc, 'buyer', 'terminated', reason);

    const already = await openComplaintOf(doc);
    if (already) {
      // Do not file a duplicate case: attach the termination to the open complaint instead.
      already.events.push({ at: new Date(), actorId: req.user._id, actorRole: req.user.role, action: 'hire_terminated', note: `${reason}: ${note}`.slice(0, 2000) });
      await already.save();
    } else if (lastApproved?.order) {
      await fileComplaint(req, doc, {
        note,
        requestedAction: req.body?.requestedAction || 'Chấm dứt dự án thuê và hoàn tiền giai đoạn đã thanh toán.',
        context: `Hire project terminated (${reason}).`,
      });
    }
    await doc.save();
    await notifyUser(
      doc.seller,
      'hire.terminated',
      { buyer: doc.buyerName, product: doc.productName, reason: note.slice(0, 200) },
      href(doc),
    ).catch(() => {});
    await notifyUser(doc.buyer, 'hire.terminatedBuyer', { product: doc.productName }, href(doc)).catch(() => {});
    await respond(res, doc, req.user._id);
  }),
);

/**
 * Buy a fixed-price professional-service package: opens the project workspace with the phase plan.
 * Nothing is charged now — each phase is charged from the wallet only when the buyer approves it.
 */
router.post(
  '/packages',
  wrap(async (req, res) => {
    const body = req.body || {};
    if (!isId(body.productId)) throw httpError(400, 'HIRE_PRODUCT_INVALID');
    const product = await Product.findById(body.productId).lean();
    if (!product || !isCatalogVisible(product) || !isHireRequestCategory(product.category)) {
      throw httpError(400, 'HIRE_PRODUCT_INVALID');
    }
    if (String(product.creator) === String(req.user._id)) throw httpError(400, 'HIRE_OWN_PRODUCT');
    const open = { $in: ['requested', 'quoted', 'active'] };
    const existing = await HireProject.findOne({ buyer: req.user._id, product: product._id, status: open }).select('_id').lean();
    if (existing) return res.status(200).json({ ...(await HireProject.findById(existing._id).then((d) => publicHire(d, req.user._id))), existing: true });
    if ((await HireProject.countDocuments({ buyer: req.user._id, status: open })) >= 20) throw httpError(429, 'HIRE_TOO_MANY');
    const milestones = packageMilestones(product);
    const total = milestones.reduce((a, m) => a + m.amount, 0);
    const brief = cleanText(body.brief, 6000) || `Gói dịch vụ: ${product.name}`;
    const doc = await HireProject.create({
      origin: 'package',
      product: product._id,
      productName: product.name,
      productSlug: product.slug,
      category: product.category,
      buyer: req.user._id,
      buyerName: req.user.name || '',
      seller: product.creator,
      sellerName: product.creatorName || '',
      brief,
      budget: total,
      currency: product.pricing?.currency || 'USD',
      listPrice: Number(product.pricing?.price) || 0,
      quote: { amount: total, note: 'Giá gói cố định', by: 'seller', at: new Date() },
      status: 'active',
      acceptedAt: new Date(),
      milestones,
      events: [{ actor: 'buyer', action: 'package_started', note: `${total} ${product.pricing?.currency || 'USD'} · ${milestones.length}` }],
    });
    await notifyUser(
      product.creator,
      'hire.packageStarted',
      { buyer: req.user.name, amount: total, currency: doc.currency, product: product.name, count: milestones.length },
      href(doc),
    ).catch(() => {});
    await respond(res, doc, req.user._id, 201);
  }),
);

router.post(
  '/projects/:id/messages',
  wrap(async (req, res) => {
    const { doc, role } = await loadForUser(req);
    assertAction(doc, role, 'message');
    const body = cleanText(req.body?.body, 4000);
    const attachments = await resolveAttachments(req.body?.attachmentIds, { scope: 'hire', scopeId: doc._id, owner: req.user._id });
    if (!body && !attachments.length) throw httpError(400, 'MESSAGE_REQUIRED');
    const link = req.body?.link ? httpsUrl(req.body.link) : '';
    doc.messages.push({ actor: role, author: req.user._id, body, link, attachments });
    if (doc.messages.length > 500) doc.messages.splice(0, doc.messages.length - 500);
    await doc.save();
    const to = role === 'buyer' ? doc.seller : doc.buyer;
    await notifyUser(to, 'hire.message', { from: req.user.name, product: doc.productName }, href(doc)).catch(() => {});
    await respond(res, doc, req.user._id);
  }),
);

router.post(
  '/projects/:id/complaint',
  wrap(async (req, res) => {
    const { doc, role } = await loadForUser(req);
    assertAction(doc, role, 'complain');
    const note = cleanText(req.body?.note, 4000);
    if (note.length < 8) throw httpError(400, 'NOTE_REQUIRED');
    if (await openComplaintOf(doc)) throw httpError(409, 'COMPLAINT_OPEN', { complaintId: String(doc.complaint) });
    await fileComplaint(req, doc, { note, requestedAction: req.body?.requestedAction, context: 'Complaint from hire workspace.' });
    pushEvent(doc, 'buyer', 'complaint', note.slice(0, 200));
    await doc.save();
    await notifyUser(doc.seller, 'hire.complaint', { buyer: doc.buyerName, product: doc.productName }, href(doc)).catch(() => {});
    await respond(res, doc, req.user._id);
  }),
);

module.exports = router;
module.exports.publicHire = publicHire;
module.exports.MESSAGES = MESSAGES;
