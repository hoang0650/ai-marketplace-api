/**
 * Complaint timelines (Quy chế 2.1, Mục XIII):
 * - acknowledge within 24 hours of receipt;
 * - preliminary verification within 1 business day;
 * - seller response within 2 business days of being notified;
 * - decision within 7 business days of a complete file;
 * - appeal within 7 days of the decision, answered within 7 business days.
 */
const { addBusinessDays, addHours, addDays } = require('./business-days');

const COMPLAINT_SLA = Object.freeze({
  acknowledgeHours: 24,
  verifyBusinessDays: 1,
  sellerResponseBusinessDays: 2,
  decisionBusinessDays: 7,
  appealWindowDays: 7,
  appealAnswerBusinessDays: 7,
});

const iso = (d) => (d ? d.toISOString() : null);

function complaintDeadlines(c) {
  const created = c?.createdAt ? new Date(c.createdAt) : null;
  const decided = c?.decidedAt ? new Date(c.decidedAt) : null;
  const appealed = c?.appealedAt ? new Date(c.appealedAt) : null;
  return {
    acknowledgeBy: created ? iso(addHours(created, COMPLAINT_SLA.acknowledgeHours)) : null,
    verifyBy: created ? iso(addBusinessDays(created, COMPLAINT_SLA.verifyBusinessDays)) : null,
    sellerResponseBy: created ? iso(addBusinessDays(created, COMPLAINT_SLA.sellerResponseBusinessDays)) : null,
    decisionBy: created ? iso(addBusinessDays(created, COMPLAINT_SLA.decisionBusinessDays)) : null,
    appealBy: decided ? iso(addDays(decided, COMPLAINT_SLA.appealWindowDays)) : null,
    appealAnswerBy: appealed ? iso(addBusinessDays(appealed, COMPLAINT_SLA.appealAnswerBusinessDays)) : null,
  };
}

function appealWindowOpen(c, now = new Date()) {
  if (!c?.decidedAt) return false;
  return new Date(now).getTime() <= addDays(new Date(c.decidedAt), COMPLAINT_SLA.appealWindowDays).getTime();
}

module.exports = { COMPLAINT_SLA, complaintDeadlines, appealWindowOpen };
