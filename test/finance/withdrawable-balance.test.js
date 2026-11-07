const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectPayoutPersona, EMPLOYER_MIN_VND, policyFor } = require('../../src/finance/payout-policy');
const { sellerEarnedAvailable, payoutCap, summaryPayable } = require('../../src/finance/withdrawable-balance');
const { affiliateConfig } = require('../../src/config/affiliate');
const { mapKyc } = require('../../src/utils/kyc');

const past = new Date('2020-01-01T00:00:00Z');
const now = new Date('2026-11-07T00:00:00Z');
const future = new Date('2026-11-09T00:00:00Z');

function order(net, extra = {}) {
  return {
    status: 'paid',
    ownershipType: 'THIRD_PARTY_SELLER',
    sellerNetAmount: net,
    payoutHoldUntil: past,
    disputeStatus: 'none',
    ...extra,
  };
}

test('ineligible and omitted personas cannot open a buyer top-up cashout', () => {
  assert.equal(selectPayoutPersona(['buyer'], ''), 'buyer');
  assert.equal(selectPayoutPersona(['buyer'], 'seller'), 'buyer');
  assert.equal(selectPayoutPersona(['buyer'], 'affiliate'), 'buyer');
  assert.equal(selectPayoutPersona(['buyer'], 'employer'), 'buyer');
  assert.equal(selectPayoutPersona(['seller', 'buyer'], ''), 'seller');
  assert.equal(selectPayoutPersona(['seller', 'buyer'], 'buyer'), 'seller');
  assert.equal(selectPayoutPersona(['seller', 'buyer'], 'employer'), 'seller');
  assert.equal(selectPayoutPersona(['seller', 'buyer', 'affiliate'], 'affiliate'), 'affiliate');
  assert.equal(selectPayoutPersona(['buyer', 'affiliate'], 'seller'), 'buyer');
  assert.equal(selectPayoutPersona(['admin'], 'employer', { isAdmin: true }), 'admin');
  assert.equal(selectPayoutPersona(['admin'], 'affiliate', { isAdmin: true }), 'affiliate');
  assert.equal(selectPayoutPersona(['admin'], 'buyer', { isAdmin: true }), 'buyer');
});

test('seller earnings are payable and topped-up balance is not', () => {
  const earned = sellerEarnedAvailable({ orders: [order(20)], now });
  assert.equal(earned.available, 20);
  const within = payoutCap({ persona: 'seller', amount: 20, poolAvailable: 120, earnedAvailable: earned.available });
  assert.equal(within.ok, true);
  assert.equal(within.payable, 20);
  const mixed = payoutCap({ persona: 'seller', amount: 21, poolAvailable: 120, earnedAvailable: 20 });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, 'PREPAID_NOT_WITHDRAWABLE');
  assert.equal(mixed.payable, 20);
  const topupOnly = payoutCap({ persona: 'seller', amount: 50, poolAvailable: 100, earnedAvailable: 0 });
  assert.equal(topupOnly.code, 'PREPAID_NOT_WITHDRAWABLE');
  assert.equal(topupOnly.payable, 0);
  assert.equal(payoutCap({ persona: 'buyer', amount: 10, poolAvailable: 100, earnedAvailable: 0 }).code, 'BUYER_CREDIT_NON_WITHDRAWABLE');
});

test('holds, clawbacks, affiliate withdrawals and buyer refund credits stay out of seller cashout', () => {
  const held = sellerEarnedAvailable({
    orders: [order(20, { payoutHoldUntil: future })],
    now,
  });
  assert.equal(held.available, 0);
  assert.equal(held.held, 20);
  const afterRefund = sellerEarnedAvailable({
    orders: [order(20, { status: 'refunded' })],
    walletTxs: [{ type: 'debit', amount: 20, status: 'completed', note: 'Refund clawback rf1 order abc' }],
    now,
  });
  assert.equal(afterRefund.available, 0);
  const refundCredit = sellerEarnedAvailable({
    walletTxs: [{ type: 'credit', amount: 40, status: 'completed', note: 'Refund rf1 order abc' }],
    now,
  });
  assert.equal(refundCredit.available, 0);
  const depositIgnored = sellerEarnedAvailable({
    orders: [order(20)],
    walletTxs: [{ type: 'deposit', amount: 100, status: 'completed', note: 'GPay top-up' }],
    now,
  });
  assert.equal(depositIgnored.available, 20);
  const affiliatePaid = sellerEarnedAvailable({
    orders: [order(20)],
    walletTxs: [{ type: 'withdraw', amount: 5, status: 'completed', meta: { persona: 'affiliate' } }],
    now,
  });
  assert.equal(affiliatePaid.available, 20);
  const legacy = sellerEarnedAvailable({
    orders: [order(20)],
    walletTxs: [{ type: 'withdraw', amount: 20, status: 'completed' }],
    now,
  });
  assert.equal(legacy.available, 0);
});

test('affiliate cashout stays on the commission slice and has no commercial minimum', () => {
  assert.equal(affiliateConfig({ AFFILIATE_MIN_WITHDRAW_VND: '2000000' }).pit.minWithdrawVnd, 0);
  const ok = payoutCap({ persona: 'affiliate', amount: 5, poolAvailable: 105, affiliateAvailable: 5, earnedAvailable: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.payable, 5);
  const over = payoutCap({ persona: 'affiliate', amount: 6, poolAvailable: 105, affiliateAvailable: 5 });
  assert.equal(over.code, 'AFFILIATE_INSUFFICIENT');
  const summary = summaryPayable({ persona: 'affiliate', poolAvailable: 105, affiliateAvailable: 5, walletBalance: 105 });
  assert.equal(summary.payableAmount, 5);
  assert.equal(summary.payableCode, null);
  const sellerSummary = summaryPayable({ persona: 'seller', poolAvailable: 120, earnedAvailable: 20, walletBalance: 120 });
  assert.equal(sellerSummary.payableAmount, 20);
  const buyerSummary = summaryPayable({ persona: 'buyer', poolAvailable: 80, walletBalance: 80 });
  assert.equal(buyerSummary.payableAmount, 0);
  assert.equal(buyerSummary.payableCode, 'BUYER_CREDIT_NON_WITHDRAWABLE');
});

test('employer minimum and seller identity policy stay in place', () => {
  assert.equal(policyFor('employer').minAmountVnd, EMPLOYER_MIN_VND);
  assert.equal(policyFor('buyer').unavailableCode, 'BUYER_CREDIT_NON_WITHDRAWABLE');
  assert.equal(policyFor('buyer').canWithdraw, false);
  const buyer = mapKyc({ role: 'buyer', kyc: { status: 'none' } });
  assert.equal(buyer.buyerIdentityRequired, false);
  assert.equal(buyer.buyerCashoutAllowed, false);
  assert.equal(buyer.prepaidWithdrawable, false);
  assert.equal(buyer.withdrawAllowed, false);
  assert.ok(buyer.identityRequiredFor.includes('seller_payout'));
  assert.ok(buyer.identityRequiredFor.includes('affiliate_payout'));
  const verifiedBuyer = mapKyc({ role: 'buyer', kyc: { status: 'verified' } });
  assert.equal(verifiedBuyer.buyerIdentityRequired, false);
  assert.equal(verifiedBuyer.buyerCashoutAllowed, false);
  assert.equal(verifiedBuyer.payoutIdentityVerified, true);
  const seller = mapKyc({ role: 'seller', kyc: { status: 'verified' } });
  assert.equal(seller.payoutIdentityVerified, true);
  assert.equal(seller.withdrawAllowed, true);
  assert.equal(seller.buyerCashoutAllowed, false);
});
