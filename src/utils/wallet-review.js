const WalletTx = require('../models/WalletTx');
const Notification = require('../models/Notification');
const { writeAuditLog } = require('./audit');
const { setPayoutStatus } = require('../finance/payout-engine');
const { mapWallet } = require('./mappers');

const REVIEWABLE = new Set(['completed', 'failed', 'cancelled']);

function notifyCopy(type, status) {
  if (type === 'deposit' && status === 'completed') {
    return { title: 'Nạp tiền đã xác nhận', body: 'Số tiền đã được cộng vào ví.', href: '/wallet' };
  }
  if (type === 'deposit') {
    return { title: 'Yêu cầu nạp bị từ chối', body: 'Admin đã từ chối hoặc hủy yêu cầu nạp tiền.', href: '/wallet' };
  }
  if (type === 'withdraw' && status === 'completed') {
    return { title: 'Rút tiền đã chuyển', body: 'Yêu cầu rút đã được thanh toán.', href: '/sell/withdraw' };
  }
  return { title: 'Yêu cầu rút bị từ chối', body: 'Số tiền đã được hoàn lại số dư khả dụng.', href: '/sell/withdraw' };
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
  await Notification.create({
    user: tx.user,
    title: copy.title,
    body: note ? `${copy.body} ${note}`.trim() : copy.body,
    href: copy.href,
  });

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
