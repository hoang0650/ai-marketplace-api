const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buyerVietqrSnapshot,
  publicBuyerDepositWithdraw,
  decideBuyerVietqrWithdrawal,
  commitBuyerVietqrDraft,
  classifyDeposit,
  isBuyerDepositWithdrawal,
  isVietqrDepositWithdrawalRequest,
  buyerVietqrWithdrawActivated,
} = require('../../src/finance/buyer-deposit-withdraw');
const { sellerEarnedAvailable } = require('../../src/finance/withdrawable-balance');
const { sellerPayoutDueMetadata } = require('../../src/finance/payout-due');
const { decideManualTaxReview, manualReviewAfterApplication, sellerApprovalGate } = require('../../src/utils/seller-compliance');
const { convertAmount } = require('../../src/finance/bank-topup-core');

const T0 = new Date('2026-11-01T00:00:00Z');
const at = (hours) => new Date(T0.getTime() + hours * 3600 * 1000);

function vietqr(vnd, usd, hours = 0) {
  return {
    type: 'deposit',
    amount: usd,
    status: 'completed',
    paymentMethod: 'bank_transfer',
    createdAt: at(hours),
    meta: { kind: 'bank_transfer_vietqr', amountVnd: vnd, vndPerUsd: vnd / usd },
  };
}

const verified = {
  role: 'buyer',
  kyc: { status: 'verified', fullName: 'Nguyen Van A', subjectType: 'individual' },
};
const account = { bankName: 'VCB', accountNumber: '0123456789', accountName: 'NGUYEN VAN A', source: 'saved' };

function openView(payableVnd = 150000, activated = true) {
  return publicBuyerDepositWithdraw({
    provenance: 'proven',
    payableVnd,
    payableUsd: 5.77,
    blockedSources: [],
    vndPerUsd: 26000,
    fxLimited: false,
  }, { electronicIdentityStatus: 'verified', poolKnown: true, activated });
}

test('public summary matches the app gate and does not submit USD', () => {
  const view = openView();
  assert.equal(view.enabled, true);
  assert.equal(view.fundingSeparated, true);
  assert.equal(view.settlement, 'VND');
  assert.equal(view.refundsSeparate, true);
  assert.equal(view.source, 'vietqr_company_bank');
  assert.equal(view.electronicIdentityStatus, 'verified');
  assert.equal(Number.isInteger(view.payableVnd), true);
  assert.equal(view.transferExecuted, false);
  assert.equal(view.legalAuthorization, 'unresolved');
  assert.equal(view.paymentAuthorization, 'unresolved');
  const closed = openView(150000, false);
  assert.equal(closed.enabled, false);
  assert.equal(closed.legalAuthorization, 'unresolved');
  assert.equal(buyerVietqrWithdrawActivated({}), false);
  assert.equal(buyerVietqrWithdrawActivated({ BUYER_VIETQR_WITHDRAW_ENABLED: 'true' }), true);
  assert.equal(buyerVietqrWithdrawActivated({ BUYER_VIETQR_WITHDRAW_ENABLED: 'yes' }), false);
  assert.equal(isVietqrDepositWithdrawalRequest({ persona: 'buyer', amount: 10 }), false);
  assert.equal(isVietqrDepositWithdrawalRequest({ source: 'vietqr_company_bank', amountVnd: 150000, amount: 999 }), true);
});

test('a non-integer or unproven payable is not offered to the client', () => {
  const fuzzy = publicBuyerDepositWithdraw({
    provenance: 'proven',
    payableVnd: 150000.5,
    payableUsd: 5,
    blockedSources: [],
  }, { electronicIdentityStatus: 'verified' });
  assert.equal(fuzzy.payableVnd, 0);
  const gap = publicBuyerDepositWithdraw({
    provenance: 'unresolved',
    payableVnd: 0,
    payableUsd: 0,
    blockedSources: [],
  }, { electronicIdentityStatus: 'verified' });
  assert.equal(gap.payableVnd, 0);
  assert.ok(gap.blockedSources.includes('unknown'));
});

test('VietQR deposits remain after a spend that happened earlier, and a later spend consumes them first', () => {
  const later = buyerVietqrSnapshot([
    { type: 'debit', amount: 40, status: 'completed', createdAt: at(0) },
    vietqr(1_000_000, 40, 2),
  ], 40, 25000);
  assert.equal(later.payableVnd, 1_000_000);
  assert.equal(later.refundsIncluded, false);

  const spent = buyerVietqrSnapshot([
    vietqr(1_000_000, 40, 0),
    { type: 'deposit', amount: 50, status: 'completed', paymentMethod: 'iap', createdAt: at(1) },
    { type: 'debit', amount: 10, status: 'completed', createdAt: at(2) },
  ], 80, 25000);
  assert.equal(spent.payableVnd, 750_000);
  assert.equal(spent.appstoreUsd, 50);
  assert.equal(spent.payableUsd, 30);
});

test('a pending spend reservation and a pending VietQR withdrawal reduce the slice', () => {
  const snap = buyerVietqrSnapshot([
    vietqr(1_000_000, 40, 0),
    { type: 'debit', amount: 5, status: 'pending', createdAt: at(1), meta: { kind: 'spend-reservation' } },
    {
      type: 'withdraw',
      amount: 10,
      status: 'pending',
      createdAt: at(2),
      meta: { persona: 'buyer', source: 'vietqr_company_bank', amountVnd: 250_000 },
    },
  ], 25, 25000);
  assert.equal(snap.payableVnd, 625_000);
  assert.equal(isBuyerDepositWithdrawal(snap), false);
});

test('refund credits, app store, GPay, PayPal and unproven transfers are not payable', () => {
  const refund = buyerVietqrSnapshot([
    { type: 'credit', amount: 40, status: 'completed', createdAt: at(0), note: 'Refund rf1' },
  ], 40, 25000);
  assert.equal(refund.payableVnd, 0);
  assert.equal(refund.vietqrDepositedVnd, 0);
  assert.equal(refund.refundCreditsUsd, 40);

  const iap = buyerVietqrSnapshot([
    { type: 'deposit', amount: 80, status: 'completed', paymentMethod: 'iap', createdAt: at(0) },
  ], 80, 25000);
  assert.equal(iap.payableVnd, 0);
  assert.deepEqual(iap.blockedSources, ['appstore']);

  const gpay = buyerVietqrSnapshot([
    { type: 'deposit', amount: 20, status: 'completed', paymentMethod: 'gpay', createdAt: at(0), meta: { kind: 'gpay_qr', amountVnd: 500_000 } },
  ], 20, 25000);
  assert.equal(gpay.payableVnd, 0);
  assert.deepEqual(gpay.blockedSources, ['gpay']);

  const unknown = buyerVietqrSnapshot([
    { type: 'deposit', amount: 12, status: 'completed', paymentMethod: 'paypal', createdAt: at(0) },
    { type: 'deposit', amount: 8, status: 'completed', paymentMethod: 'bank_transfer', createdAt: at(1), meta: { kind: 'legacy' } },
  ], 20, 25000);
  assert.equal(unknown.payableVnd, 0);
  assert.deepEqual(unknown.blockedSources, ['unknown']);
  assert.equal(classifyDeposit({ paymentMethod: 'bank_transfer', meta: { kind: 'bank_transfer_vietqr' } }), 'unproven');
});

test('an FX move cannot spend app-store dollars to fund extra VND', () => {
  const snap = buyerVietqrSnapshot([
    vietqr(1_000_000, 40, 0),
    { type: 'deposit', amount: 100, status: 'completed', paymentMethod: 'google_pay', createdAt: at(1) },
  ], 140, 20000);
  assert.ok(snap.payableVnd < 1_000_000);
  assert.ok(snap.payableVnd > 0);
  assert.equal(snap.fxLimited, true);
  const conv = convertAmount({ amount: snap.payableVnd, currency: 'VND' }, 20000);
  assert.ok(Math.round(conv.amountUsd * 100) <= 4000);
  assert.equal(snap.blockedSources.includes('appstore'), true);
});

test('a buyer withdrawal without a stored VND amount closes the slice', () => {
  const snap = buyerVietqrSnapshot([
    vietqr(1_000_000, 40, 0),
    { type: 'withdraw', amount: 10, status: 'completed', createdAt: at(1), meta: { persona: 'buyer' } },
  ], 30, 25000);
  assert.equal(snap.provenance, 'unresolved');
  assert.equal(snap.payableVnd, 0);
});

test('the cash-out switch stays closed until an operator sets it, and that setting is not a license', () => {
  const rows = [vietqr(1_000_000, 40, 0)];
  const closed = decideBuyerVietqrWithdrawal({
    user: verified,
    amountVnd: 100_000,
    account,
    rows,
    poolAvailableUsd: 40,
    vndPerUsd: 25000,
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.code, 'WITHDRAW_NOT_ACTIVATED');
  assert.equal(closed.draft, undefined);
});

test('electronic identity is user.kyc only; admin role and a tax review do not pass', () => {
  const rows = [vietqr(1_000_000, 40, 0)];
  const admin = decideBuyerVietqrWithdrawal({
    activated: true,
    user: { role: 'admin', kyc: { status: 'pending', fullName: 'Nguyen Van A' } },
    amountVnd: 100_000,
    account,
    rows,
    poolAvailableUsd: 40,
    vndPerUsd: 25000,
  });
  assert.equal(admin.code, 'KYC_REQUIRED');
  const mismatch = decideBuyerVietqrWithdrawal({
    activated: true,
    user: verified,
    amountVnd: 100_000,
    account: { ...account, accountName: 'TRAN THI B' },
    rows,
    poolAvailableUsd: 40,
    vndPerUsd: 25000,
  });
  assert.equal(mismatch.code, 'ACCOUNT_NAME_MISMATCH');
  const missing = decideBuyerVietqrWithdrawal({
    activated: true,
    user: verified,
    amountVnd: 100_000,
    account: null,
    rows,
    poolAvailableUsd: 40,
    vndPerUsd: 25000,
  });
  assert.equal(missing.code, 'BANK_ACCOUNT_REQUIRED');
});

test('a matching holder can withdraw only the proven VND and a second click replays', () => {
  const rows = [vietqr(1_000_000, 40, 0)];
  const first = decideBuyerVietqrWithdrawal({
    activated: true,
    user: verified,
    amountVnd: 250_000,
    account,
    rows,
    poolAvailableUsd: 40,
    vndPerUsd: 25000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.draft.amountVnd, 250_000);
  assert.equal(first.draft.amountUsd, 10);
  assert.equal(first.draft.account.accountName, 'NGUYEN VAN A');

  const over = decideBuyerVietqrWithdrawal({
    activated: true,
    user: verified,
    amountVnd: 1_000_001,
    account,
    rows,
    poolAvailableUsd: 40,
    vndPerUsd: 25000,
  });
  assert.equal(over.code, 'DEPOSIT_CAP');

  const pending = {
    _id: 'wd1',
    type: 'withdraw',
    amount: 10,
    status: 'pending',
    createdAt: at(1),
    meta: { source: 'vietqr_company_bank', persona: 'buyer', amountVnd: 250_000 },
  };
  const replay = decideBuyerVietqrWithdrawal({
    activated: true,
    user: verified,
    amountVnd: 250_000,
    account: null,
    rows: [...rows, pending],
    poolAvailableUsd: 30,
    vndPerUsd: 25000,
  });
  assert.equal(replay.replay, pending);
  assert.equal(replay.draft, undefined);
  const other = decideBuyerVietqrWithdrawal({
    activated: true,
    user: verified,
    amountVnd: 100_000,
    idempotencyKey: 'withdraw-key-1',
    account,
    rows: [...rows, { ...pending, meta: { ...pending.meta, idempotencyKey: 'withdraw-key-1' } }],
    poolAvailableUsd: 30,
    vndPerUsd: 25000,
  });
  assert.equal(other.code, 'IDEMPOTENCY_CONFLICT');
});

test('a failed payout record cancels the wallet reservation', async () => {
  let cancelled = 0;
  await assert.rejects(() => commitBuyerVietqrDraft({ amountVnd: 1000, amountUsd: 1 }, {
    createTx: async () => ({ _id: 'tx1', status: 'pending' }),
    createPayout: async () => { throw new Error('payout store failed'); },
    cancelTx: async () => { cancelled += 1; },
    linkPayout: async () => { throw new Error('should not link'); },
  }));
  assert.equal(cancelled, 1);
});

test('a buyer deposit withdrawal does not reduce seller earnings evidence', () => {
  const withdrawal = {
    type: 'withdraw',
    amount: 10,
    status: 'pending',
    meta: { persona: 'buyer', source: 'vietqr_company_bank' },
  };
  const earned = sellerEarnedAvailable({
    orders: [{ status: 'paid', ownershipType: 'THIRD_PARTY_SELLER', sellerNetAmount: 40, payoutHoldUntil: new Date('2020-01-01') }],
    walletTxs: [withdrawal],
    now: new Date('2026-11-08'),
  });
  assert.equal(earned.available, 40);
  const sellerWithdrawal = sellerEarnedAvailable({
    orders: [{ status: 'paid', ownershipType: 'THIRD_PARTY_SELLER', sellerNetAmount: 40, payoutHoldUntil: new Date('2020-01-01') }],
    walletTxs: [{ type: 'withdraw', amount: 10, status: 'pending', meta: { persona: 'seller' } }],
    now: new Date('2026-11-08'),
  });
  assert.equal(sellerWithdrawal.available, 30);
});

test('seller due date is three business days after the later of hold end and the request', () => {
  const same = sellerPayoutDueMetadata({ requestedAt: '2026-10-09T03:00:00Z', holdEndsAt: '2026-10-09T03:00:00Z' });
  assert.equal(same.holdHours, 48);
  assert.equal(same.payoutDueBusinessDays, 3);
  assert.equal(same.payoutDueBasis, 'later_of_hold_end_and_valid_request');
  assert.equal(same.payoutDueAt, '2026-10-14T03:00:00.000Z');
  assert.equal(same.transferExecuted, false);
  const holdLater = sellerPayoutDueMetadata({ requestedAt: '2026-10-09T03:00:00Z', holdEndsAt: '2026-10-14T03:00:00Z' });
  assert.equal(holdLater.payoutDueAt, '2026-10-19T03:00:00.000Z');
});

test('manual tax review is an admin attestation and does not replace eKYC', () => {
  assert.equal(decideManualTaxReview({ actorRole: 'seller', status: 'approved', reason: 'Đã đối chiếu MST', lookupAttested: true }).code, 'RBAC');
  assert.equal(decideManualTaxReview({ actorRole: 'admin', status: 'rejected', reason: 'no', lookupAttested: false }).code, 'REASON_REQUIRED');
  assert.equal(decideManualTaxReview({ actorRole: 'admin', status: 'approved', reason: 'Đã đối chiếu MST', lookupAttested: false }).code, 'LOOKUP_ATTESTATION_REQUIRED');
  const ok = decideManualTaxReview({ actorRole: 'admin', status: 'approved', reason: 'Đã đối chiếu MST', lookupAttested: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.lookupAttested, true);
  assert.equal(sellerApprovalGate({
    sellerType: 'INDIVIDUAL',
    taxCode: '012345678901',
    manualTaxReview: { status: 'approved' },
  }, { status: 'pending' }).code, 'SELLER_KYC_REQUIRED');
  const same = manualReviewAfterApplication({
    before: { taxCode: '012345678901', sellerType: 'INDIVIDUAL', legalName: 'A', businessRegistrationNumber: '' },
    after: { taxCode: '012345678901', sellerType: 'INDIVIDUAL', legalName: 'A', businessRegistrationNumber: '', verificationStatus: 'VERIFIED' },
    current: { status: 'approved' },
  });
  assert.equal(same.reset, false);
  assert.equal(same.demoteVerified, false);
  const changed = manualReviewAfterApplication({
    before: { taxCode: '012345678901', sellerType: 'INDIVIDUAL', legalName: 'A', businessRegistrationNumber: '' },
    after: { taxCode: '099999999999', sellerType: 'INDIVIDUAL', legalName: 'A', businessRegistrationNumber: '', verificationStatus: 'VERIFIED' },
    current: { status: 'approved' },
  });
  assert.equal(changed.reset, true);
  assert.equal(changed.demoteVerified, true);
});
