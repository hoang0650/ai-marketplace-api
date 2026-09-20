const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  HOLD_HOURS,
  HOLD_MS,
  holdUntil,
  isPayoutHeld,
  holdKind,
  canOpenDispute,
  effectiveSellerNet,
} = require('../../src/utils/payout-hold');

const HOUR = 60 * 60 * 1000;

function paidOrder(overrides = {}) {
  const completedAt = overrides.completedAt || new Date('2026-09-18T00:00:00.000Z');
  return {
    status: 'paid',
    amount: 100,
    sellerNetAmount: 72,
    ownershipType: 'THIRD_PARTY_SELLER',
    disputeStatus: 'none',
    completedAt,
    payoutHoldUntil: new Date(completedAt.getTime() + HOLD_MS),
    ...overrides,
  };
}

describe('48h seller payout hold', () => {
  test('default window is 48 hours', () => {
    assert.equal(HOLD_HOURS, 48);
    assert.equal(HOLD_MS, 48 * HOUR);
  });

  test('seller net is frozen during the 48h protection window', () => {
    const order = paidOrder();
    const t12 = new Date(order.completedAt.getTime() + 12 * HOUR);
    const t48 = new Date(order.completedAt.getTime() + HOLD_MS);
    const t49 = new Date(order.completedAt.getTime() + HOLD_MS + 60_000);
    assert.equal(isPayoutHeld(order, t12), true);
    assert.equal(holdKind(order, t12), 'protection_window');
    assert.equal(canOpenDispute(order, t12), true);
    assert.equal(isPayoutHeld(order, t48), false);
    assert.equal(canOpenDispute(order, t48), false);
    assert.equal(isPayoutHeld(order, t49), false);
    assert.equal(canOpenDispute(order, t49), false);
  });

  test('open buyer dispute keeps money frozen after the 48h window', () => {
    const order = paidOrder({ disputeStatus: 'open' });
    const t72 = new Date(order.completedAt.getTime() + 72 * HOUR);
    assert.equal(isPayoutHeld(order, t72), true);
    assert.equal(holdKind(order, t72), 'dispute');
    assert.equal(canOpenDispute(order, t72), false);
  });

  test('buyer cannot open a second dispute after one is filed', () => {
    const order = paidOrder({ disputeStatus: 'open' });
    const t1 = new Date(order.completedAt.getTime() + HOUR);
    assert.equal(canOpenDispute(order, t1), false);
  });

  test('seller_win releases the hold so payout can proceed', () => {
    const order = paidOrder({ disputeStatus: 'seller_win' });
    const t1 = new Date(order.completedAt.getTime() + HOUR);
    assert.equal(isPayoutHeld(order, t1), false);
    assert.equal(canOpenDispute(order, t1), false);
  });

  test('buyer_win / refunded order is not held', () => {
    const open = paidOrder({ disputeStatus: 'buyer_win' });
    const refunded = paidOrder({ status: 'refunded', disputeStatus: 'buyer_win' });
    const t1 = new Date(open.completedAt.getTime() + HOUR);
    assert.equal(isPayoutHeld(open, t1), false);
    assert.equal(isPayoutHeld(refunded, t1), false);
  });

  test('holdUntil prefers snapshot payoutHoldUntil', () => {
    const completedAt = new Date('2026-09-18T00:00:00.000Z');
    const payoutHoldUntil = new Date('2026-09-20T12:00:00.000Z');
    const until = holdUntil({ completedAt, payoutHoldUntil });
    assert.equal(until.toISOString(), payoutHoldUntil.toISOString());
  });

  test('effectiveSellerNet uses snapshot, not 80% of gross', () => {
    const order = paidOrder({ amount: 1_000_000, sellerNetAmount: 720_000, platformFee: 200_000 });
    assert.equal(effectiveSellerNet(order), 720_000);
  });
});
