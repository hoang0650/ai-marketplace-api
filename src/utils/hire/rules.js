const { HIRE_REQUEST_CATEGORIES } = require('../../data/categories');

const MAX_MILESTONES = 10;
const MAX_AMOUNT = 100_000;
/** Hire categories whose demo must be a live Builder project on AI Markets. */
const BUILDER_DEMO_KIND = { 'hire-build-web': 'web', 'hire-build-app': 'app' };

function httpError(status, code, extra) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  if (extra) err.extra = extra;
  return err;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function isHireRequestCategory(category) {
  return HIRE_REQUEST_CATEGORIES.includes(String(category || ''));
}

function parseAmount(raw, code = 'AMOUNT_INVALID') {
  const amount = roundMoney(raw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw httpError(400, code);
  return amount;
}

/**
 * Buyer-defined payout schedule: 1–10 phases, each with a positive amount and a
 * strictly later future due date; amounts must add up to the agreed quote.
 */
function normalizeMilestones(raw, { total, now = new Date() } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw httpError(400, 'MILESTONES_REQUIRED');
  if (list.length > MAX_MILESTONES) throw httpError(400, 'MILESTONES_TOO_MANY');
  let prevDue = now.getTime();
  let sum = 0;
  const out = list.map((m, i) => {
    const title = String(m?.title || '').trim().slice(0, 200) || `Giai đoạn ${i + 1}`;
    const amount = parseAmount(m?.amount, 'MILESTONE_AMOUNT_INVALID');
    const due = new Date(m?.dueAt);
    if (Number.isNaN(due.getTime())) throw httpError(400, 'MILESTONE_DUE_INVALID');
    if (due.getTime() <= prevDue) throw httpError(400, i === 0 ? 'MILESTONE_DUE_PAST' : 'MILESTONE_DUE_ORDER');
    prevDue = due.getTime();
    sum += amount;
    return { title, amount, dueAt: due, status: i === 0 ? 'in_progress' : 'pending' };
  });
  if (Math.abs(roundMoney(sum) - roundMoney(total)) > 0.009) {
    throw httpError(400, 'MILESTONES_SUM_MISMATCH', { total: roundMoney(total), sum: roundMoney(sum) });
  }
  return out;
}

function roleIn(project, userId) {
  const id = String(userId || '');
  if (!id) return null;
  if (String(project.buyer?._id || project.buyer) === id) return 'buyer';
  if (String(project.seller?._id || project.seller) === id) return 'seller';
  return null;
}

/** The phase being worked on or awaiting acceptance (at most one at a time). */
function currentMilestone(project) {
  return (project.milestones || []).find((m) => m.status === 'in_progress' || m.status === 'submitted') || null;
}

function isOverdue(milestone, now = new Date()) {
  if (!milestone?.dueAt) return false;
  const due = new Date(milestone.dueAt).getTime();
  if (milestone.status === 'in_progress') return due < now.getTime();
  if (milestone.status === 'submitted' || milestone.status === 'approved') {
    return !!milestone.submittedAt && new Date(milestone.submittedAt).getTime() > due;
  }
  return false;
}

/** Throws unless `actor` may run `action` in the project's current status. */
function assertAction(project, actor, action) {
  const s = project.status;
  const allowed = {
    quote: actor === 'seller' && (s === 'requested' || s === 'quoted'),
    decline: actor === 'seller' && (s === 'requested' || s === 'quoted'),
    counter: actor === 'buyer' && s === 'quoted',
    cancel: actor === 'buyer' && (s === 'requested' || s === 'quoted'),
    accept: actor === 'buyer' && s === 'quoted',
    submit: actor === 'seller' && s === 'active' && currentMilestone(project)?.status === 'in_progress',
    approve: actor === 'buyer' && s === 'active' && currentMilestone(project)?.status === 'submitted',
    revision: actor === 'buyer' && s === 'active' && currentMilestone(project)?.status === 'submitted',
    terminate: actor === 'buyer' && s === 'active',
  }[action];
  if (!allowed) throw httpError(409, 'HIRE_ACTION_NOT_ALLOWED', { status: s, action });
}

/** Marks the current phase approved and opens the next one; returns true when the project is finished. */
function advanceAfterApproval(project, { orderId = null, now = new Date() } = {}) {
  const m = currentMilestone(project);
  if (!m || m.status !== 'submitted') throw httpError(409, 'HIRE_ACTION_NOT_ALLOWED');
  m.status = 'approved';
  m.approvedAt = now;
  m.order = orderId;
  const next = (project.milestones || []).find((x) => x.status === 'pending');
  if (next) {
    next.status = 'in_progress';
    return false;
  }
  project.status = 'completed';
  project.completedAt = now;
  return true;
}

/** Cancels every unpaid phase; returns the approved phase whose payout may still be disputed. */
function cancelOpenMilestones(project) {
  let lastApproved = null;
  for (const m of project.milestones || []) {
    if (m.status === 'approved') lastApproved = m;
    else m.status = 'cancelled';
  }
  return lastApproved;
}

function paidTotal(project) {
  return roundMoney(
    (project.milestones || []).filter((m) => m.status === 'approved').reduce((s, m) => s + (Number(m.amount) || 0), 0),
  );
}

module.exports = {
  MAX_MILESTONES,
  BUILDER_DEMO_KIND,
  httpError,
  roundMoney,
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
};
