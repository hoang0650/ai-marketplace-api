const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Complaint = require('../models/Complaint');
const WalletTx = require('../models/WalletTx');
const GpuRental = require('../models/GpuRental');
const Product = require('../models/Product');
const AgentSubscription = require('../models/AgentSubscription');
const MarketplaceApiKey = require('../models/MarketplaceApiKey');
const ProviderApiKey = require('../models/ProviderApiKey');
const GitConnection = require('../models/GitConnection');
const Cart = require('../models/Cart');
const Notification = require('../models/Notification');
const AccountDeletionRequest = require('../models/AccountDeletionRequest');
const { getAvailableBalance } = require('../utils/wallet');
const { invalidateAuthUserCache } = require('../middleware/auth');
const { deleteCachePattern } = require('../utils/cache');
const { writeAuditLog } = require('../utils/audit');
const {
  evaluateDeletionBlockers,
  anonymizedUserUpdate,
  retentionUntil,
  shouldRetainKyc,
} = require('../utils/account-deletion');

const CLOSED_COMPLAINT = ['decided', 'closed'];

async function collectDeletionState(userId) {
  const id = new mongoose.Types.ObjectId(String(userId));
  const either = { $or: [{ buyer: id }, { seller: id }] };
  const [wallet, pendingWithdrawals, openOrders, openDisputes, openComplaints, activeGpu] = await Promise.all([
    getAvailableBalance(id).catch(() => ({ balance: 0 })),
    WalletTx.countDocuments({ user: id, type: 'withdraw', status: 'pending' }),
    Order.countDocuments({ ...either, paymentStatus: 'paid', fulfillmentStatus: 'pending' }),
    Order.countDocuments({ ...either, disputeStatus: 'open' }),
    Complaint.countDocuments({ $or: [{ complainant: id }, { seller: id }], status: { $nin: CLOSED_COMPLAINT } }),
    GpuRental.countDocuments({ owner: id, status: { $in: ['creating', 'running'] } }),
  ]);
  return {
    walletBalance: Number(wallet.balance) || 0,
    pendingWithdrawals,
    openOrders,
    openDisputes,
    openComplaints,
    activeGpu,
  };
}

async function deletionPreview(userId) {
  const state = await collectDeletionState(userId);
  return { state, ...evaluateDeletionBlockers(state) };
}

/** Anonymise the user and clean up personal data. Caller checks confirmation and blockers. */
async function deleteAccount(user, { source = 'app', reason = '', ip = '', userAgent = '' } = {}) {
  const now = new Date();
  const id = user._id;
  const kycRetained = shouldRetainKyc(user.kyc);
  await Promise.all([
    MarketplaceApiKey.updateMany({ user: id, status: 'active' }, { $set: { status: 'revoked' } }),
    ProviderApiKey.deleteMany({ user: id }),
    GitConnection.deleteMany({ user: id }),
    Cart.deleteMany({ user: id }),
    Notification.deleteMany({ user: id }),
    Product.updateMany({ creator: id }, { $set: { published: false } }),
    AgentSubscription.updateMany({ user: id }, { $set: { autoRenew: false } }),
  ]);
  await User.updateOne({ _id: id }, anonymizedUserUpdate(user, now));
  await invalidateAuthUserCache(id);
  await deleteCachePattern('products:*').catch(() => {});
  const record = await AccountDeletionRequest.create({
    user: id,
    source,
    status: 'completed',
    reason: String(reason || '').slice(0, 1000),
    requestedAt: now,
    completedAt: now,
    retentionUntil: retentionUntil(now),
    kycRetained,
    ip,
  });
  await writeAuditLog({
    actorId: id,
    actorRole: user.role || '',
    action: 'account.self_delete',
    resourceType: 'User',
    resourceId: id,
    newValue: { source, kycRetained, requestId: String(record._id) },
    ip,
    userAgent,
    reason: 'user_requested_deletion',
  });
  return { requestId: String(record._id), deletedAt: now, retentionUntil: record.retentionUntil, kycRetained };
}

module.exports = { collectDeletionState, deletionPreview, deleteAccount };
