const crypto = require('crypto');
const SellerPayout = require('../models/SellerPayout');
const SellerProfile = require('../models/SellerProfile');
const { writeAuditLog } = require('../utils/audit');

function canPayoutSeller(profile) {
  if (!profile) {
    return { ok: false, status: 'ON_HOLD', holdReason: 'SELLER_PROFILE_REQUIRED' };
  }
  if (profile.verificationStatus === 'SUSPENDED' || profile.verificationStatus === 'TERMINATED') {
    return { ok: false, status: 'ON_HOLD', holdReason: 'SELLER_SUSPENDED' };
  }
  if (profile.verificationStatus === 'REJECTED') {
    return { ok: false, status: 'ON_HOLD', holdReason: 'SELLER_REJECTED' };
  }
  if (profile.verificationStatus !== 'VERIFIED') {
    return { ok: false, status: 'ON_HOLD', holdReason: 'SELLER_NOT_VERIFIED' };
  }
  return { ok: true, status: 'PENDING', holdReason: '' };
}

async function createPayout({
  sellerId,
  orderIds = [],
  payableAmount,
  taxAmount = 0,
  commissionAmount = 0,
  paymentFee = 0,
  currency = 'USD',
  actorId = null,
  idempotencyKey = '',
}) {
  if (idempotencyKey) {
    const existing = await SellerPayout.findOne({ idempotencyKey });
    if (existing) return { payout: existing, duplicate: true };
  }

  const profile = await SellerProfile.findOne({ user: sellerId }).lean();
  const gate = canPayoutSeller(profile);
  const payoutId = `po_${crypto.randomBytes(8).toString('hex')}`;
  const payout = await SellerPayout.create({
    payoutId,
    sellerId,
    orderIds,
    payableAmount,
    taxAmount,
    commissionAmount,
    paymentFee,
    currency,
    status: gate.ok ? 'PENDING' : 'ON_HOLD',
    holdReason: gate.holdReason,
    idempotencyKey: idempotencyKey || payoutId,
  });

  await writeAuditLog({
    actorId,
    action: 'PAYOUT_CREATED',
    resourceType: 'SellerPayout',
    resourceId: payoutId,
    newValue: { status: payout.status, payableAmount, holdReason: payout.holdReason },
  });

  return { payout, duplicate: false, eligible: gate.ok };
}

async function setPayoutStatus(payoutId, status, { actorId = null, reason = '' } = {}) {
  const payout = await SellerPayout.findOne({ payoutId });
  if (!payout) {
    const err = new Error('Payout not found');
    err.status = 404;
    throw err;
  }
  const before = payout.status;
  payout.status = status;
  if (status === 'PAID') payout.paidAt = new Date();
  if (reason) payout.holdReason = reason;
  await payout.save();
  await writeAuditLog({
    actorId,
    action: `PAYOUT_${status}`,
    resourceType: 'SellerPayout',
    resourceId: payoutId,
    oldValue: { status: before },
    newValue: { status },
    reason,
  });
  return payout;
}

module.exports = { canPayoutSeller, createPayout, setPayoutStatus };
