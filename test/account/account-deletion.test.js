const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  evaluateDeletionBlockers,
  isConfirmWord,
  retentionUntil,
  deletedEmail,
  shouldRetainKyc,
  anonymizedUserUpdate,
  deletionNotice,
  RETENTION_YEARS,
  DELETED_NAME,
} = require('../../src/utils/account-deletion');

describe('account deletion blockers', () => {
  test('nothing open: can delete', () => {
    const r = evaluateDeletionBlockers({ walletBalance: 0.004, openOrders: 0 });
    assert.equal(r.canDelete, true);
    assert.deepEqual(r.blockers, []);
  });
  test('wallet balance, open orders, disputes, complaints, withdrawals and GPU block', () => {
    const r = evaluateDeletionBlockers({
      walletBalance: 12.345, pendingWithdrawals: 1, openOrders: 2, openDisputes: 1, openComplaints: 3, activeGpu: 1,
    });
    assert.equal(r.canDelete, false);
    assert.deepEqual(r.blockers.map((b) => b.code), [
      'WALLET_BALANCE', 'PENDING_WITHDRAWAL', 'OPEN_ORDERS', 'OPEN_DISPUTES', 'OPEN_COMPLAINTS', 'ACTIVE_GPU',
    ]);
    assert.equal(r.blockers[0].count, 12.35);
    assert.ok(r.blockers.every((b) => b.message));
  });
});

describe('confirmation and retention', () => {
  test('accepts XÓA / XOA / delete / 删除, rejects others', () => {
    for (const w of ['XÓA', 'xoa', ' delete ', '删除', 'Xoá']) assert.equal(isConfirmWord(w), true, w);
    for (const w of ['', 'yes', 'xóa tài khoản', null]) assert.equal(isConfirmWord(w), false, String(w));
  });
  test('transaction data is kept 03 years', () => {
    assert.equal(RETENTION_YEARS, 3);
    assert.equal(retentionUntil(new Date('2026-10-13T00:00:00Z')).toISOString(), '2029-10-13T00:00:00.000Z');
    const n = deletionNotice();
    assert.ok(n.retained.some((s) => s.includes('3 năm')));
    assert.equal(n.webUrl, 'https://aimarkets.vn/account/delete');
    assert.equal(n.irreversible, true);
  });
  test('only submitted KYC is retained', () => {
    assert.equal(shouldRetainKyc({ status: 'none' }), false);
    assert.equal(shouldRetainKyc({ status: 'draft' }), false);
    assert.equal(shouldRetainKyc(undefined), false);
    for (const s of ['pending', 'verified', 'rejected']) assert.equal(shouldRetainKyc({ status: s }), true);
  });
});

describe('anonymised tombstone', () => {
  const id = new mongoose.Types.ObjectId();
  const now = new Date('2026-10-13T03:00:00Z');
  test('erases personal profile data and blocks sign-in', () => {
    const u = anonymizedUserUpdate({ _id: id, tokenVersion: 4, kyc: { status: 'draft' } }, now);
    assert.equal(u.$set.email, deletedEmail(id));
    assert.match(u.$set.email, /@deleted\.aimarkets\.invalid$/);
    assert.equal(u.$set.name, DELETED_NAME);
    assert.equal(u.$set.passwordHash, '');
    assert.equal(u.$set.avatarUrl, '');
    assert.equal(u.$set.bio, '');
    assert.equal(u.$set.affiliateCode, '');
    assert.deepEqual(u.$set.wishlist, []);
    assert.equal(u.$set.accountStatus, 'deleted');
    assert.equal(u.$set.deletedAt, now);
    assert.equal(u.$set.tokenVersion, 5);
    assert.deepEqual(u.$unset, { googleId: '', creatorSlug: '' });
    assert.deepEqual(u.$set.kyc, { status: 'none' });
  });
  test('keeps submitted KYC for the legal retention period', () => {
    const u = anonymizedUserUpdate({ _id: id, kyc: { status: 'verified' } }, now);
    assert.equal('kyc' in u.$set, false);
  });
  test('User model accepts the deleted status and moderation explains it', () => {
    const User = require('../../src/models/User');
    const doc = new User({ email: deletedEmail(id), name: DELETED_NAME, accountStatus: 'deleted' });
    assert.equal(doc.validateSync(), undefined);
    const { denyMessage } = require('../../src/utils/moderation');
    assert.match(denyMessage('deleted'), /deleted/);
  });
  test('account routes load', () => {
    const router = require('../../src/routes/account');
    const paths = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
    assert.deepEqual(paths.sort(), ['get /deletion', 'post /deletion', 'post /deletion-requests']);
  });
});
