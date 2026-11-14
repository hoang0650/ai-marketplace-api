const { addBusinessDays } = require('../utils/business-days');
const { HOLD_HOURS } = require('../utils/payout-hold');

/**
 * Due-date metadata for a payout request.
 * Business days are counted from the later of the 48h hold end and the valid
 * request. This does not start a bank transfer.
 * Seller earnings stay on 3 working days. Affiliate commission is 7.
 */
function payoutDueMetadata({ requestedAt = new Date(), holdEndsAt = null, businessDays = 3 } = {}) {
  const requestMs = new Date(requestedAt).getTime();
  const holdMs = holdEndsAt == null ? requestMs : new Date(holdEndsAt).getTime();
  const safeRequest = Number.isFinite(requestMs) ? requestMs : Date.now();
  const safeHold = Number.isFinite(holdMs) ? holdMs : safeRequest;
  const basisMs = Math.max(safeRequest, safeHold);
  const days = Math.max(0, Math.floor(Number(businessDays) || 0));
  const due = addBusinessDays(new Date(basisMs), days);
  return {
    holdHours: HOLD_HOURS,
    payoutDueBusinessDays: days,
    payoutDueBasis: 'later_of_hold_end_and_valid_request',
    holdEndsAt: new Date(safeHold).toISOString(),
    validRequestAt: new Date(safeRequest).toISOString(),
    payoutDueAt: due ? due.toISOString() : null,
    transferExecuted: false,
  };
}

function sellerPayoutDueMetadata(opts = {}) {
  return payoutDueMetadata({ ...opts, businessDays: 3 });
}

function affiliatePayoutDueMetadata(opts = {}) {
  return payoutDueMetadata({ ...opts, businessDays: 7 });
}

module.exports = { sellerPayoutDueMetadata, affiliatePayoutDueMetadata, payoutDueMetadata };
