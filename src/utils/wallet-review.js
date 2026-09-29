const WalletTx = require('../models/WalletTx');
const { notifyUser } = require('./notify');
const { writeAuditLog } = require('./audit');
const { setPayoutStatus } = require('../finance/payout-engine');
const { mapWallet } = require('./mappers');

const REVIEWABLE = new Set(['completed', 'failed', 'cancelled']);

function notifyCopy(type, status) {
  if (type === 'deposit' && status === 'completed') return { key: 'wallet.depositCompleted', href: '/wallet' };
  if (type === 'deposit') return { key: 'wallet.depositRejected', href: '/wallet' };
  if (type === 'withdraw' && status === 'completed') return { key: 'wallet.withdrawCompleted', href: '/sell/withdraw' };
  return { key: 'wallet.withdrawRejected', href: '/sell/withdraw' };
}

async function reviewWalletTx(id, status, { actorId = null, note = '' } = {}) {
  const next = String(status || '').toLowerCase();
  if (!REVIEWABLE.has(next)) {
    const err = new Error('status must be completed, failed, or cancelled');
    err.status = 400;
    throw err;
  }

  const tx = await WalletTx.findById(id);
  if (!tx) {
    const err = new Error('Wallet transaction not found');
    err.status = 404;
    throw err;
  }

  const current = tx.status || 'completed';
  if (current === next) {
    const populated = await tx.populate('user', 'name email role');
    return mapWallet(populated);
  }
  if (current !== 'pending') {
    const err = new Error('Chỉ có thể duyệt giao dịch đang chờ');
    err.status = 400;
    err.code = 'NOT_PENDING';
    throw err;
  }
  if (tx.type !== 'deposit' && tx.type !== 'withdraw') {
    const err = new Error('Chỉ duyệt nạp hoặc rút tiền');
    err.status = 400;
    throw err;
  }

  const before = current;
  tx.status = next;
  tx.reviewedAt = new Date();
  tx.reviewedBy = actorId || null;
  if (note) tx.reviewNote = String(note).slice(0, 500);
  await tx.save();

  if (tx.type === 'withdraw' && tx.payoutId) {
    const payoutStatus = next === 'completed' ? 'PAID' : next === 'failed' ? 'FAILED' : 'CANCELLED';
    try {
      await setPayoutStatus(tx.payoutId, payoutStatus, { actorId, reason: note });
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  const copy = notifyCopy(tx.type, next);
  await notifyUser(tx.user, copy.key, { note: String(note || '').trim() || undefined }, copy.href);

  await writeAuditLog({
    actorId,
    action: `WALLET_${tx.type.toUpperCase()}_${next.toUpperCase()}`,
    resourceType: 'WalletTx',
    resourceId: tx._id,
    oldValue: { status: before },
    newValue: { status: next, reviewNote: tx.reviewNote },
    reason: note,
  });

  const populated = await tx.populate('user', 'name email role');
  return mapWallet(populated);
}

module.exports = { reviewWalletTx, REVIEWABLE };
