const WalletTx = require('../models/WalletTx');
const LedgerEntry = require('../models/LedgerEntry');
const { requireAvailableFunds } = require('../utils/wallet');
const { newEntryId } = require('./ledger-service');
const { vndToUsd } = require('./payout-policy');
const { isAdmin } = require('../utils/roles');

/**
 * Work is a listing board: AI Markets only charges a flat fee per HR job post /
 * talent profile and is not a party to deals agreed there (unlike /marketplace).
 */
function listingFee() {
  const raw = Number(process.env.WORK_LISTING_FEE_VND ?? 20000);
  const vnd = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
  return { vnd, amount: vndToUsd(vnd), currency: 'USD' };
}

/** Checks the wallet without writing anything (call before creating the listing). */
async function assertCanPayListingFee(user) {
  const fee = listingFee();
  if (isAdmin(user) || fee.amount <= 0) return { ...fee, charged: false };
  await requireAvailableFunds(user._id, fee.amount, { currency: fee.currency });
  return { ...fee, charged: true };
}

async function chargeListingFee(user, { listingType, listingId, title }) {
  const fee = listingFee();
  if (isAdmin(user) || fee.amount <= 0) return { ...fee, charged: false };
  const meta = { kind: 'work_listing_fee', listingType, listingId: String(listingId), feeVnd: fee.vnd };
  await WalletTx.create({
    user: user._id,
    type: 'debit',
    amount: fee.amount,
    currency: fee.currency,
    note: `Phí đăng tin Work (${listingType === 'job' ? 'tin tuyển dụng' : 'hồ sơ talent'}): ${String(title || '').slice(0, 120)}`,
    meta,
  });
  await LedgerEntry.create({
    entryId: newEntryId('wfee'),
    buyerId: user._id,
    type: 'PLATFORM_REVENUE',
    amount: fee.amount,
    currency: fee.currency,
    direction: 'credit',
    ownershipType: 'PLATFORM_DIRECT',
    reference: `work:${listingType}:${listingId}:listing-fee`,
    meta,
  }).catch((err) => console.error('[ledger] work fee', err.message));
  return { ...fee, charged: true };
}

module.exports = { listingFee, assertCanPayListingFee, chargeListingFee };
