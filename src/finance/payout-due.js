const { addBusinessDays } = require('../utils/business-days');
const { HOLD_HOURS } = require('../utils/payout-hold');

/**
 * Due-date metadata for a seller-like payout request.
 * Three Vietnam business days are counted from the later of the 48h hold end
 * and the valid request. This does not start a bank transfer and does not
 * assert that a draft policy is already in force.
 */
function sellerPayoutDueMetadata({ requestedAt = new Date(), holdEndsAt = null } = {}) {
  const requestMs = new Date(requestedAt).getTime();
  const holdMs = holdEndsAt == null ? requestMs : new Date(holdEndsAt).getTime();
  const safeRequest = Number.isFinite(requestMs) ? requestMs : Date.now();
  const safeHold = Number.isFinite(holdMs) ? holdMs : safeRequest;
  const basisMs = Math.max(safeRequest, safeHold);
  const due = addBusinessDays(new Date(basisMs), 3);
  return {
    holdHours: HOLD_HOURS,
    payoutDueBusinessDays: 3,
    payoutDueBasis: 'later_of_hold_end_and_valid_request',
    holdEndsAt: new Date(safeHold).toISOString(),
    validRequestAt: new Date(safeRequest).toISOString(),
    payoutDueAt: due ? due.toISOString() : null,
    transferExecuted: false,
  };
}

module.exports = { sellerPayoutDueMetadata };
