const { effectiveSellerNet, roundMoney } = require('./payout-hold');
const { parseEvidenceUrls } = require('./complaint-helpers');

/** Label both parties see on staff messages. The staff member's name stays in the audit log. */
const ADMIN_DISPUTE_LABEL = 'AI Markets (Admin)';

const OUTCOME_VI = {
  buyer_full: 'người mua thắng — hoàn toàn bộ',
  buyer_partial: 'người mua thắng — hoàn một phần',
  seller: 'người bán thắng — giải phóng tiền tạm giữ',
  split: 'chia: hoàn một phần cho người mua, phần còn lại giải phóng cho người bán',
};

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function idOf(v) {
  if (!v) return '';
  if (typeof v === 'object') return String(v._id || v.id || '');
  return String(v);
}

/** admin, or the buyer, or the seller. Anyone else is null. */
function disputePartyRole(user, order) {
  if (!user || !order) return null;
  if (user.role === 'admin') return 'admin';
  const me = idOf(user._id || user.id);
  if (!me) return null;
  if (me === idOf(order.buyer)) return 'buyer';
  if (me === idOf(order.seller)) return 'seller';
  return null;
}

/**
 * Parties and admins can read a dispute that exists. Everyone else gets 404
 * (same response as a missing dispute, so order ids are not confirmed).
 */
function assertCanViewDispute(user, order) {
  if (!order || (order.disputeStatus || 'none') === 'none') {
    throw httpError(404, 'Dispute not found', 'DISPUTE_NOT_FOUND');
  }
  const role = disputePartyRole(user, order);
  if (!role) throw httpError(404, 'Dispute not found', 'DISPUTE_NOT_FOUND');
  return role;
}

function assertCanResolveDispute(user, order) {
  if (!user || user.role !== 'admin') throw httpError(403, 'Forbidden', 'FORBIDDEN');
  if (!order) throw httpError(404, 'Order not found', 'NOT_FOUND');
  return 'admin';
}

function validateDisputeMessage({ body, attachmentCount = 0 } = {}) {
  const text = String(body || '').trim().slice(0, 4000);
  if (!text && !(Number(attachmentCount) > 0)) {
    throw httpError(400, 'Message or attachment required', 'MESSAGE_EMPTY');
  }
  return text;
}

/** Role is taken from the viewer, never from the request body. */
function buildDisputeMessage(user, order, { body, attachments } = {}) {
  const role = assertCanViewDispute(user, order);
  const list = Array.isArray(attachments) ? attachments : [];
  const text = validateDisputeMessage({ body, attachmentCount: list.length });
  return {
    author: user._id || user.id || null,
    authorName: role === 'admin' ? ADMIN_DISPUTE_LABEL : String(user.name || '').slice(0, 200),
    role,
    kind: 'message',
    outcome: '',
    body: text,
    attachments: list,
    at: new Date(),
  };
}

/**
 * Pure decision plan. Money movement stays in resolveOrderDispute, which calls
 * the existing createRefund / hold-release paths with these amounts.
 */
function planDisputeResolution(order, { resolution, note = '', refundAmount, requireNote = false } = {}) {
  if (!order || (order.disputeStatus || 'none') !== 'open') {
    throw httpError(400, 'This order has no open dispute', 'DISPUTE_NOT_OPEN');
  }
  const res = String(resolution || '');
  if (!['seller', 'buyer', 'split'].includes(res)) {
    throw httpError(400, 'resolution must be seller, buyer, or split', 'DISPUTE_RESOLUTION');
  }
  const text = String(note || '').trim().slice(0, 1000);
  if (requireNote && text.length < 8) {
    throw httpError(400, 'A written reason is required (at least 8 characters)', 'DISPUTE_REASON_REQUIRED');
  }
  const gross = roundMoney(Number(order.amount) || 0);
  const sellerNet = effectiveSellerNet(order);
  let refund = 0;
  if (res === 'buyer') {
    if (gross <= 0) refund = 0;
    else if (refundAmount == null || refundAmount === '') refund = gross;
    else {
      refund = roundMoney(Number(refundAmount));
      if (!Number.isFinite(refund) || refund <= 0) {
        throw httpError(400, 'Refund amount must be greater than 0', 'DISPUTE_AMOUNT');
      }
      if (refund > gross + 0.001) {
        throw httpError(400, 'Refund amount cannot exceed the order total', 'DISPUTE_AMOUNT');
      }
      refund = Math.min(refund, gross);
    }
  } else if (res === 'split') {
    refund = roundMoney(Number(refundAmount));
    if (!Number.isFinite(refund) || refund <= 0 || !(gross > 0) || refund >= gross - 0.001) {
      throw httpError(400, 'Split refund must be greater than 0 and less than the order total', 'DISPUTE_AMOUNT');
    }
  }
  const ratio = gross > 0 ? Math.min(1, refund / gross) : 0;
  const sellerKept = roundMoney(sellerNet * (1 - ratio));
  let outcome = 'seller';
  let disputeStatus = 'seller_win';
  if (res === 'split') {
    outcome = 'split';
    disputeStatus = 'split';
  } else if (res === 'buyer') {
    const partial = gross > 0 && refund < gross - 0.001;
    outcome = partial ? 'buyer_partial' : 'buyer_full';
    disputeStatus = 'buyer_win';
  }
  return {
    resolution: res,
    note: text,
    refundGross: refund,
    sellerKept,
    outcome,
    disputeStatus,
    ratio,
    gross,
    sellerNet,
  };
}

/** Legacy GET /admin/disputes (no query) stays an array for the current dashboard. */
function wantsPagedDisputes(query = {}) {
  return ['page', 'limit', 'q', 'status'].some((k) => String(query[k] ?? '').trim() !== '');
}

function cleanName(value) {
  return String(value ?? '').trim();
}

/**
 * Names shown on admin dispute rows and dispute detail.
 * Buyer: current account name, otherwise the name stored on the order.
 * Seller: current account name, otherwise SellerProfile.displayName.
 */
function disputePartyNames(order, { buyer, seller, profile } = {}) {
  return {
    buyerName: cleanName(buyer?.name) || cleanName(order?.buyerName),
    sellerName: cleanName(seller?.name) || cleanName(profile?.displayName),
  };
}

/** User ids whose account name or shop display name matched a dispute search. */
function disputeSellerSearchIds({ users = [], profiles = [] } = {}) {
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const id = idOf(value);
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const user of users) add(user);
  for (const profile of profiles) add(profile?.user);
  return ids;
}

function disputeListFilter({ status, q, rx, sellerIds } = {}) {
  const base =
    status === 'open'
      ? { disputeStatus: 'open' }
      : status === 'resolved'
        ? { disputeStatus: { $in: ['seller_win', 'buyer_win', 'split'] } }
        : { disputeStatus: { $ne: 'none' } };
  if (!rx) return base;
  const or = [
    { productName: rx },
    { buyerName: rx },
    { disputeReason: rx },
    { disputeResolutionNote: rx },
  ];
  if (/^[a-f0-9]{24}$/i.test(String(q || '').trim())) or.push({ _id: String(q).trim() });
  const matchedSellers = [];
  const seenSellers = new Set();
  for (const sellerId of Array.isArray(sellerIds) ? sellerIds : []) {
    const id = idOf(sellerId);
    if (!id || seenSellers.has(id)) continue;
    seenSellers.add(id);
    matchedSellers.push(id);
  }
  if (matchedSellers.length) or.push({ seller: { $in: matchedSellers } });
  return { $and: [base, { $or: or }] };
}

function ensureThread(order) {
  if (!Array.isArray(order.disputeMessages)) order.disputeMessages = [];
  if (!Array.isArray(order.disputeEvents)) order.disputeEvents = [];
}

/** Mutates the order: opening claim becomes the first thread message. Does not save. */
function applyDisputeOpen(order, { reason, actorName, actorId, evidenceUrls, attachments } = {}) {
  const { canOpenDispute } = require('./payout-hold');
  if (!canOpenDispute(order)) {
    throw httpError(
      400,
      'Cannot dispute this order. Disputes are only allowed within 48 hours of completion, and only once.',
      'DISPUTE_WINDOW_CLOSED',
    );
  }
  const text = String(reason || '').trim().slice(0, 1000);
  if (text.length < 8) {
    throw httpError(400, 'Please describe the issue (at least 8 characters)', 'DISPUTE_REASON_SHORT');
  }
  const at = new Date();
  order.disputeStatus = 'open';
  order.disputeReason = text;
  order.disputeOpenedAt = at;
  order.disputeEvidenceUrls = parseEvidenceUrls(evidenceUrls);
  ensureThread(order);
  order.disputeMessages.push({
    author: actorId || order.buyer || null,
    authorName: String(actorName || order.buyerName || '').slice(0, 200),
    role: 'buyer',
    kind: 'opened',
    outcome: '',
    body: text,
    attachments: Array.isArray(attachments) ? attachments : [],
    at,
  });
  order.disputeEvents.push({
    at,
    actorId: actorId || order.buyer || null,
    actorRole: 'buyer',
    action: 'opened',
    note: text.slice(0, 200),
  });
  return order;
}

module.exports = {
  ADMIN_DISPUTE_LABEL,
  OUTCOME_VI,
  httpError,
  idOf,
  disputePartyRole,
  assertCanViewDispute,
  assertCanResolveDispute,
  validateDisputeMessage,
  buildDisputeMessage,
  planDisputeResolution,
  wantsPagedDisputes,
  disputePartyNames,
  disputeSellerSearchIds,
  disputeListFilter,
  ensureThread,
  applyDisputeOpen,
};
