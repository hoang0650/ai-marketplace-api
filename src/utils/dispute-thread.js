const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Complaint = require('../models/Complaint');
const AuditLog = require('../models/AuditLog');
const { mapOrder } = require('./mappers');
const { isPayoutHeld, effectiveSellerNet } = require('./payout-hold');
const {
  ADMIN_DISPUTE_LABEL,
  assertCanViewDispute,
  buildDisputeMessage,
  ensureThread,
  idOf,
} = require('./dispute-access');

function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

function mapThreadMessage(m) {
  const { mapEmbedded } = require('../routes/attachments');
  const role = m.role;
  const authorName = role === 'admin' ? ADMIN_DISPUTE_LABEL : m.authorName || '';
  return {
    id: m._id ? String(m._id) : '',
    authorId: m.author ? String(m.author) : '',
    role,
    authorName,
    label: authorName,
    kind: m.kind || 'message',
    outcome: m.outcome || '',
    body: m.body || '',
    attachments: mapEmbedded(m.attachments),
    at: iso(m.at),
  };
}

async function postDisputeMessage(order, user, { body, attachmentIds } = {}) {
  assertCanViewDispute(user, order);
  let attachments = [];
  const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
  if (ids.length) {
    const { resolveAttachments } = require('../routes/attachments');
    attachments = await resolveAttachments(ids, {
      scope: 'dispute',
      scopeId: order._id,
      owner: user._id,
    });
  }
  const message = buildDisputeMessage(user, order, { body, attachments });
  ensureThread(order);
  order.disputeMessages.push(message);
  order.disputeEvents.push({
    at: message.at,
    actorId: user._id || null,
    actorRole: message.role,
    action: 'message',
    note: (message.body || `[${attachments.length} files]`).slice(0, 200),
  });
  await order.save();

  const { notifyUser, notifyMany } = require('./notify');
  const preview = (message.body || `${attachments.length} tệp`).slice(0, 180);
  const href = `/orders/${order._id}`;
  if (message.role === 'admin') {
    await notifyMany([order.buyer, order.seller], 'dispute.message', { actor: ADMIN_DISPUTE_LABEL, preview }, href);
  } else {
    const other = message.role === 'buyer' ? order.seller : order.buyer;
    await notifyUser(other, 'dispute.message', { actor: message.authorName || message.role, preview }, href);
  }
  return order;
}

async function mapDisputeDetail(order, { viewerRole = 'buyer' } = {}) {
  const adminView = viewerRole === 'admin';
  const o = typeof order.toObject === 'function' ? order.toObject({ virtuals: true }) : order;
  const buyerId = idOf(o.buyer);
  const sellerId = idOf(o.seller);
  const productId = idOf(o.product);
  const [people, product, complaint, audits] = await Promise.all([
    User.find({ _id: { $in: [buyerId, sellerId].filter(Boolean) } })
      .select('name email avatarUrl creatorSlug role')
      .lean(),
    productId ? Product.findById(productId).select('name slug').lean() : null,
    Complaint.findOne({ order: o._id }).select('caseRef status').sort({ createdAt: -1 }).lean(),
    adminView
      ? AuditLog.find({ resourceType: 'Order', resourceId: String(o._id || o.id), action: 'dispute.resolve' })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean()
      : [],
  ]);
  const byId = new Map(people.map((u) => [String(u._id), u]));
  const person = (id) => {
    const u = byId.get(String(id));
    if (!u && !id) return null;
    const slug = u?.creatorSlug || '';
    return {
      id: String(id || ''),
      name: u?.name || (id === buyerId ? o.buyerName || '' : ''),
      email: adminView ? u?.email || '' : '',
      avatarUrl: u?.avatarUrl || '',
      role: u?.role || '',
      creatorSlug: slug,
      href: adminView ? `/admin/users/${id}` : slug ? `/store/${slug}` : null,
      shopHref: slug ? `/store/${slug}` : null,
    };
  };
  const held = isPayoutHeld(o);
  const sellerNet = effectiveSellerNet(o);
  const slug = product?.slug || '';
  return {
    ...mapOrder(o, { viewerRole }),
    buyer: person(buyerId),
    seller: person(sellerId),
    product: {
      id: productId,
      name: product?.name || o.productName || '',
      slug,
      href: slug ? `/product/${slug}` : null,
      adminHref: adminView && productId ? `/admin/products/${productId}` : null,
    },
    orderHref: `/orders/${o._id || o.id}`,
    amounts: {
      gross: Number(o.amount) || 0,
      currency: o.currency || 'USD',
      sellerNet,
      held: held ? sellerNet : 0,
      payoutHeld: held,
      refund: Number(o.disputeRefundAmount) || 0,
      sellerKept: Number(o.disputeSellerKeptAmount) || 0,
    },
    evidenceUrls: Array.isArray(o.disputeEvidenceUrls) ? o.disputeEvidenceUrls : [],
    outcome: o.disputeOutcome || '',
    resolutionNote: o.disputeResolutionNote || '',
    messages: (o.disputeMessages || []).map(mapThreadMessage),
    timeline: (o.disputeEvents || []).map((e) => ({
      at: iso(e.at),
      actorRole: e.actorRole || '',
      action: e.action,
      note: e.note || '',
    })),
    complaint: complaint
      ? {
          id: String(complaint._id),
          caseRef: complaint.caseRef || '',
          status: complaint.status || '',
          href: adminView ? `/admin/complaints/${complaint._id}` : `/complaints/${complaint._id}`,
        }
      : null,
    audit: adminView
      ? (audits || []).map((a) => ({
      id: String(a._id),
      action: a.action,
      reason: a.reason || '',
      actorId: a.actorId ? String(a.actorId) : '',
      oldValue: a.oldValue || null,
      newValue: a.newValue || null,
      createdAt: iso(a.createdAt),
    }))
      : [],
  };
}

async function reloadOrder(id) {
  return Order.findById(id);
}

module.exports = { mapThreadMessage, postDisputeMessage, mapDisputeDetail, reloadOrder };
