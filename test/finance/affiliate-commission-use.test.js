const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  COMMISSION_BANK_ONLY_MESSAGE,
  COMMISSION_BANK_ONLY_CODE,
  forbiddenCommissionUse,
  decideAffiliateWithdrawal,
  historicalCommissionCreditFilter,
} = require('../../src/finance/affiliate-use-policy');
const { affiliatePayoutDueMetadata, sellerPayoutDueMetadata } = require('../../src/finance/payout-due');
const { buyerVietqrWithdrawActivated } = require('../../src/finance/buyer-deposit-withdraw');
const { quoteAffiliateWithdrawal } = require('../../src/finance/affiliate-engine');
const { installFakeLedger, restoreStubs } = require('../helpers/fake-ledger');
const { getSpendableBalance, getAvailableBalance, requireAvailableFunds } = require('../../src/utils/wallet');

const REGISTERED = {
  bankName: 'Vietcombank',
  accountNumber: '0123456789',
  accountName: 'Nguyen Van A',
};

describe('affiliate commission cannot move into the wallet or pay for an order', () => {
  test('transfer to wallet is rejected with the bank-only message', () => {
    for (const body of [
      { persona: 'affiliate', amount: 10, destination: 'wallet' },
      { persona: 'affiliate', amount: 10, withdrawTo: 'internal_balance' },
      { action: 'convert_commission', amount: 5 },
      { transferToWallet: true, amount: 5 },
      { channel: 'to_wallet' },
    ]) {
      const denied = forbiddenCommissionUse(body);
      assert.equal(denied.status, 403);
      assert.equal(denied.code, COMMISSION_BANK_ONLY_CODE);
      assert.equal(denied.message, COMMISSION_BANK_ONLY_MESSAGE);
      const decision = decideAffiliateWithdrawal({
        body,
        registered: REGISTERED,
        payoutPool: 10,
        affiliateAvailable: 10,
      });
      assert.equal(decision.ok, false);
      assert.equal(decision.status, 403);
      assert.equal(decision.message, COMMISSION_BANK_ONLY_MESSAGE);
    }
  });

  test('paying with commission is rejected with the same message', () => {
    for (const body of [
      { productId: 'p1', paymentSource: 'affiliate_commission' },
      { productId: 'p1', payWith: 'commission' },
      { productId: 'p1', source: 'hoa_hong' },
      { useCommission: true },
    ]) {
      const denied = forbiddenCommissionUse(body);
      assert.equal(denied.status, 403);
      assert.equal(denied.code, COMMISSION_BANK_ONLY_CODE);
      assert.equal(denied.message, COMMISSION_BANK_ONLY_MESSAGE);
    }
    assert.equal(forbiddenCommissionUse({ productId: 'p1', salesChannel: 'WEB' }), null);
    assert.equal(forbiddenCommissionUse({ persona: 'seller', amount: 10, bankAccount: REGISTERED }), null);
  });
});

describe('affiliate bank payout still uses the registered account and has no minimum', () => {
  test('payout to the affiliate registered account is allowed', () => {
    const omitted = decideAffiliateWithdrawal({
      body: { persona: 'affiliate', amount: 1.25 },
      registered: REGISTERED,
      payoutPool: 40,
      affiliateAvailable: 12.5,
    });
    assert.equal(omitted.ok, true);
    assert.equal(omitted.payable, 12.5);
    assert.equal(omitted.account.accountNumber, '0123456789');
    assert.equal(omitted.account.bankName, 'Vietcombank');
    assert.equal(omitted.account.source, 'registered');

    const same = decideAffiliateWithdrawal({
      body: {
        persona: 'affiliate',
        amount: 0.01,
        bankAccount: {
          bankName: 'vietcombank',
          accountNumber: '0123 456 789',
          accountName: 'Nguyễn Văn A',
        },
      },
      registered: REGISTERED,
      payoutPool: 0.01,
      affiliateAvailable: 0.01,
    });
    assert.equal(same.ok, true);
    assert.equal(same.payable, 0.01);
    const quote = quoteAffiliateWithdrawal({ amount: 0.01, available: same.payable, currency: 'USD', digits: 2 });
    assert.equal(quote.ok, true);
    assert.equal(quote.gross, 0.01);
  });

  test('a bank account that is not the registered one is rejected', () => {
    const other = decideAffiliateWithdrawal({
      body: {
        persona: 'affiliate',
        amount: 10,
        bankAccount: { bankName: 'ACB', accountNumber: '999888777', accountName: 'Nguyen Van A' },
      },
      registered: REGISTERED,
      payoutPool: 10,
      affiliateAvailable: 10,
    });
    assert.equal(other.ok, false);
    assert.equal(other.status, 403);
    assert.equal(other.code, COMMISSION_BANK_ONLY_CODE);
    assert.equal(other.message, COMMISSION_BANK_ONLY_MESSAGE);
  });

  test('payout without a registered account is rejected and nothing is deleted', () => {
    const missing = decideAffiliateWithdrawal({
      body: { persona: 'affiliate', amount: 10 },
      registered: { bankName: '', accountNumber: '', accountName: '' },
      payoutPool: 10,
      affiliateAvailable: 10,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 400);
    assert.equal(missing.code, 'BANK_ACCOUNT_REQUIRED');
    const filter = historicalCommissionCreditFilter();
    assert.equal(filter.type, 'credit');
    assert.ok(filter.$or.some((clause) => clause['meta.source'] === 'affiliate_commission'));
    assert.ok(filter.$or.some((clause) => clause.note));
  });

  test('affiliate payout is due in 7 working days; seller payout stays 3', () => {
    const fri = new Date('2026-10-09T03:00:00Z');
    const affiliate = affiliatePayoutDueMetadata({ requestedAt: fri });
    const seller = sellerPayoutDueMetadata({ requestedAt: fri });
    assert.equal(affiliate.payoutDueBusinessDays, 7);
    assert.equal(affiliate.holdHours, 48);
    assert.equal(affiliate.payoutDueAt, '2026-10-20T03:00:00.000Z');
    assert.equal(affiliate.transferExecuted, false);
    assert.equal(seller.payoutDueBusinessDays, 3);
    assert.equal(seller.payoutDueAt, '2026-10-14T03:00:00.000Z');
  });

  test('buyer prepaid withdrawal stays switched off', () => {
    assert.equal(buyerVietqrWithdrawActivated({}), false);
    assert.equal(buyerVietqrWithdrawActivated({ BUYER_TOPUP_WITHDRAW_ACTIVATED: 'true' }), false);
    assert.equal(buyerVietqrWithdrawActivated({ BUYER_VIETQR_WITHDRAW_ENABLED: '' }), false);
  });
});

describe('commission is excluded from the spendable balance', () => {
  let saved;
  let db;
  beforeEach(() => {
    saved = [];
    db = installFakeLedger({ saved });
  });
  afterEach(() => restoreStubs(saved));

  function creditCommission(user, amount) {
    db.commissions.push({
      _id: new mongoose.Types.ObjectId(),
      affiliate: String(user),
      status: 'active',
      netAmount: amount,
      reversedAmount: 0,
      holdUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
      order: new mongoose.Types.ObjectId(),
    });
    db.tx.push({
      _id: new mongoose.Types.ObjectId(),
      user: String(user),
      type: 'credit',
      amount,
      status: 'completed',
      note: `Affiliate commission 25% · order ${user}`,
      meta: { source: 'affiliate_commission', spendable: false },
      createdAt: new Date(),
    });
  }

  test('released commission cannot pay a charge; a top-up still can; the credit row stays', async () => {
    const user = String(new mongoose.Types.ObjectId());
    db.fund(user, 20);
    creditCommission(user, 50);
    const before = db.tx.length;

    const summary = await getAvailableBalance(user);
    assert.equal(summary.balance, 70);
    assert.equal(summary.payoutAvailable, 70);
    assert.equal(summary.affiliateReleased, 50);
    assert.equal(summary.available, 20);
    assert.equal(await getSpendableBalance(user), 20);

    const ok = await requireAvailableFunds(user, 20);
    assert.equal(ok.spendable, 20);

    await assert.rejects(requireAvailableFunds(user, 21), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, COMMISSION_BANK_ONLY_CODE);
      assert.equal(err.message, COMMISSION_BANK_ONLY_MESSAGE);
      return true;
    });
    await assert.rejects(requireAvailableFunds(user, 80), { status: 402, code: 'INSUFFICIENT_WALLET' });
    assert.equal(db.tx.length, before);
    assert.equal(db.commissions.length, 1);
  });

  test('a wallet that is only released commission cannot be spent', async () => {
    const user = String(new mongoose.Types.ObjectId());
    creditCommission(user, 8);
    assert.equal(await getSpendableBalance(user), 0);
    await assert.rejects(requireAvailableFunds(user, 1), {
      status: 403,
      code: COMMISSION_BANK_ONLY_CODE,
      message: COMMISSION_BANK_ONLY_MESSAGE,
    });
    assert.equal(db.tx.length, 1);
  });

  test('a top-up with no commission stays spendable', async () => {
    const user = String(new mongoose.Types.ObjectId());
    db.fund(user, 15);
    assert.equal(await getSpendableBalance(user), 15);
    const summary = await requireAvailableFunds(user, 15);
    assert.equal(summary.available, 15);
  });
});
