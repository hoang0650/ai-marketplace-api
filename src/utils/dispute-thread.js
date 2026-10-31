const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Complaint = require('../models/Complaint');
const AuditLog = require('../models/AuditLog');
const SellerProfile = require('../models/SellerProfile');
const { mapOrder } = require('./mappers');
const { isPayoutHeld, effectiveSellerNet } = require('./payout-hold');
const {
  ADMIN_DISPUTE_LABEL,
  assertCanViewDispute,
  buildDisputeMessage,
  disputePartyNames,
  disputeSellerSearchIds,
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

async function mapDisputeDetail(order, { viewerRole = 'buyer' } = {}, deps = {}) {
  const adminView = viewerRole === 'admin';
  const UserModel = deps.User || User;
  const ProductModel = deps.Product || Product;
  const ComplaintModel = deps.Complaint || Complaint;
  const AuditModel = deps.AuditLog || AuditLog;
  const Profile = deps.SellerProfile || SellerProfile;
  const o = typeof order.toObject === 'function' ? order.toObject({ virtuals: true }) : order;
  const buyerId = idOf(o.buyer);
  const sellerId = idOf(o.seller);
  const productId = idOf(o.product);
  const [people, product, complaint, audits, sellerProfile] = await Promise.all([
    UserModel.find({ _id: { $in: [buyerId, sellerId].filter(Boolean) } })
      .select('name email avatarUrl creatorSlug role')
      .lean(),
    productId ? ProductModel.findById(productId).select('name slug').lean() : null,
    ComplaintModel.findOne({ order: o._id }).select('caseRef status').sort({ createdAt: -1 }).lean(),
    adminView
      ? AuditModel.find({ resourceType: 'Order', resourceId: String(o._id || o.id), action: 'dispute.resolve' })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean()
      : [],
    sellerId ? Profile.findOne({ user: sellerId }).select('displayName').lean() : null,
  ]);
  const byId = new Map(people.map((u) => [idOf(u), u]));
  const names = disputePartyNames(o, {
    buyer: byId.get(buyerId),
    seller: byId.get(sellerId),
    profile: sellerProfile,
  });
  const person = (id, name) => {
    const u = byId.get(String(id));
    if (!u && !id) return null;
    const slug = u?.creatorSlug || '';
    return {
      id: String(id || ''),
      name: name || '',
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
    buyerName: names.buyerName,
    sellerName: names.sellerName,
    buyer: person(buyerId, names.buyerName),
    seller: person(sellerId, names.sellerName),
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

/** Seller ids whose account name or shop display name matches the admin dispute search. */
async function findDisputeSellerIds(rx, deps = {}) {
  if (!rx) return [];
  const UserModel = deps.User || User;
  const Profile = deps.SellerProfile || SellerProfile;
  const [users, profiles] = await Promise.all([
    UserModel.find({ name: rx }).select('_id').lean(),
    Profile.find({ displayName: rx }).select('user').lean(),
  ]);
  return disputeSellerSearchIds({ users, profiles });
}

/** Admin dispute list rows, with the current buyer and seller names filled in. */
async function mapAdminDisputeRows(orders, deps = {}) {
  const list = Array.isArray(orders) ? orders : [];
  const UserModel = deps.User || User;
  const Profile = deps.SellerProfile || SellerProfile;
  const userIds = [];
  const sellerIds = [];
  const seenUsers = new Set();
  const seenSellers = new Set();
  for (const order of list) {
    const buyerId = idOf(order.buyer);
    const sellerId = idOf(order.seller);
    if (buyerId && !seenUsers.has(buyerId)) {
      seenUsers.add(buyerId);
      userIds.push(buyerId);
    }
    if (sellerId && !seenUsers.has(sellerId)) {
      seenUsers.add(sellerId);
      userIds.push(sellerId);
    }
    if (sellerId && !seenSellers.has(sellerId)) {
      seenSellers.add(sellerId);
      sellerIds.push(sellerId);
    }
  }
  const [users, profiles] = await Promise.all([
    userIds.length ? UserModel.find({ _id: { $in: userIds } }).select('name').lean() : [],
    sellerIds.length ? Profile.find({ user: { $in: sellerIds } }).select('user displayName').lean() : [],
  ]);
  const usersById = new Map((users || []).map((user) => [idOf(user), user]));
  const profilesByUser = new Map((profiles || []).map((profile) => [idOf(profile.user), profile]));
  return list.map((order) => {
    const names = disputePartyNames(order, {
      buyer: usersById.get(idOf(order.buyer)),
      seller: usersById.get(idOf(order.seller)),
      profile: profilesByUser.get(idOf(order.seller)),
    });
    return {
      ...mapOrder(order, { viewerRole: 'admin' }),
      buyerName: names.buyerName,
      sellerName: names.sellerName,
    };
  });
}

module.exports = {
  mapThreadMessage,
  postDisputeMessage,
  mapDisputeDetail,
  reloadOrder,
  findDisputeSellerIds,
  mapAdminDisputeRows,
};
