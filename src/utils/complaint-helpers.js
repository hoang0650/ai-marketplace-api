const User = require('../models/User');
const Notification = require('../models/Notification');
const { writeAuditLog } = require('./audit');

function caseRefFromId(id) {
  return `KN-${String(id).slice(-8).toUpperCase()}`;
}

function mapComplaint(doc) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  return {
    id: String(o._id || o.id),
    caseRef: o.caseRef || caseRefFromId(o._id || o.id),
    complainantId: o.complainant ? String(o.complainant._id || o.complainant) : '',
    complainantName: o.complainantName || '',
    complainantEmail: o.complainantEmail || '',
    kind: o.kind,
    orderId: o.order ? String(o.order._id || o.order) : null,
    productId: o.product ? String(o.product._id || o.product) : null,
    productName: o.productName || '',
    sellerId: o.seller ? String(o.seller._id || o.seller) : null,
    body: o.body || '',
    requestedAction: o.requestedAction || '',
    evidenceUrls: Array.isArray(o.evidenceUrls) ? o.evidenceUrls : [],
    status: o.status || 'received',
    sellerResponse: o.sellerResponse || '',
    sellerRespondedAt: o.sellerRespondedAt ? new Date(o.sellerRespondedAt).toISOString() : null,
    decision: o.decision || '',
    decisionNote: o.decisionNote || '',
    decidedAt: o.decidedAt ? new Date(o.decidedAt).toISOString() : null,
    appealReason: o.appealReason || '',
    appealedAt: o.appealedAt ? new Date(o.appealedAt).toISOString() : null,
    openedOrderDispute: !!o.openedOrderDispute,
    closedAt: o.closedAt ? new Date(o.closedAt).toISOString() : null,
    events: (o.events || []).map((e) => ({
      at: e.at ? new Date(e.at).toISOString() : new Date().toISOString(),
      actorRole: e.actorRole || '',
      action: e.action,
      note: e.note || '',
    })),
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: o.updatedAt ? new Date(o.updatedAt).toISOString() : new Date().toISOString(),
  };
}

function pushEvent(complaint, req, action, note = '') {
  complaint.events.push({
    at: new Date(),
    actorId: req.user?._id || null,
    actorRole: req.user?.role || '',
    action,
    note: String(note || '').slice(0, 2000),
  });
}

function parseEvidenceUrls(raw) {
  const list = Array.isArray(raw)
    ? raw
    : String(raw || '')
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
  const urls = [];
  for (const item of list.slice(0, 5)) {
    let parsed;
    try {
      parsed = new URL(item);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    urls.push(parsed.toString().slice(0, 500));
  }
  return urls;
}

function canAccessComplaint(user, complaint) {
  const uid = String(user._id);
  if (user.role === 'admin') return true;
  if (String(complaint.complainant) === uid) return true;
  if (complaint.seller && String(complaint.seller) === uid) return true;
  return false;
}

async function notifyUsers(userIds, { title, body, href }) {
  const ids = [...new Set(userIds.filter(Boolean).map((id) => String(id)))];
  if (!ids.length) return;
  await Notification.insertMany(
    ids.map((user) => ({ user, title, body, href })),
  );
}

async function notifyAdmins(payload) {
  const admins = await User.find({ role: 'admin', accountStatus: 'active' }).select('_id').lean();
  await notifyUsers(
    admins.map((u) => u._id),
    payload,
  );
}

async function auditComplaint(req, action, complaint, extra = {}) {
  await writeAuditLog({
    actorId: req.user?._id || null,
    actorRole: req.user?.role || '',
    action,
    resourceType: 'complaint',
    resourceId: String(complaint._id),
    newValue: { status: complaint.status, decision: complaint.decision, ...extra },
    ip: req.ip || '',
    userAgent: req.headers?.['user-agent'] || '',
    reason: extra.reason || '',
  });
}

module.exports = {
  caseRefFromId,
  mapComplaint,
  pushEvent,
  parseEvidenceUrls,
  canAccessComplaint,
  notifyUsers,
  notifyAdmins,
  auditComplaint,
};
