const mongoose = require('mongoose');
const WalletTx = require('../models/WalletTx');
const { getSellerHolds, roundMoney } = require('./payout-hold');
const { getAffiliateHolds } = require('../finance/affiliate-service');

const MAX_TX_AMOUNT = 100_000; // sanity cap per transaction (USD)

function normalizeAmount(raw) {
  const amount = Math.round(Number(raw) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_TX_AMOUNT) return null;
  return amount;
}

function toObjectId(id) {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
}

/** Completed deposits/credits minus completed+pending withdraw/debit (pending withdraw reserves funds). */
async function getBalance(userId) {
  userId = toObjectId(userId); // aggregate() does not cast string ids
  const [row] = await WalletTx.aggregate([
    { $match: { user: userId } },
    {
      $group: {
        _id: null,
        balance: {
          $sum: {
            $let: {
              vars: { st: { $ifNull: ['$status', 'completed'] } },
              in: {
                $switch: {
                  branches: [
                    {
                      case: {
                        $and: [
                          { $in: ['$type', ['credit', 'deposit']] },
                          { $eq: ['$$st', 'completed'] },
                        ],
                      },
                      then: '$amount',
                    },
                    {
                      case: {
                        $and: [
                          { $in: ['$type', ['debit', 'withdraw']] },
                          { $in: ['$$st', ['completed', 'pending']] },
                        ],
                      },
                      then: { $multiply: ['$amount', -1] },
                    },
                  ],
                  default: 0,
                },
              },
            },
          },
        },
      },
    },
  ]);
  return row?.balance || 0;
}

/** Ledger minus frozen sale payouts and affiliate commissions (48h window or open dispute on that order only). */
async function getAvailableBalance(userId) {
  const balance = roundMoney(await getBalance(userId));
  const seller = await getSellerHolds(userId);
  const aff = await getAffiliateHolds(userId).catch(() => ({ held: 0, holds: [] }));
  const held = roundMoney(seller.held + aff.held);
  const holds = [...seller.holds, ...aff.holds];
  const available = roundMoney(Math.max(0, balance - held));
  return { balance, held, available, holds };
}

/** Spend / checkout must use available funds so 48h hold stays reserved for buyer disputes. */
async function requireAvailableFunds(userId, amount, { currency = 'USD' } = {}) {
  const need = Number(amount) || 0;
  const summary = await getAvailableBalance(userId);
  if (need <= 0) return summary;
  if (summary.available + 1e-9 >= need) return summary;
  const err = new Error(
    summary.held > 0
      ? `Insufficient available balance. Ledger ${summary.balance.toFixed(2)}, held ${summary.held.toFixed(2)} (48h protection or open dispute), available ${summary.available.toFixed(2)}.`
      : `Insufficient internal ledger entitlement (need ${need.toFixed(2)} ${currency}, have ${summary.available.toFixed(2)}).`,
  );
  err.status = 402;
  err.code = summary.held > 0 ? 'PAYOUT_HELD' : 'INSUFFICIENT_WALLET';
  err.body = { ...summary, amount: need, currency };
  throw err;
}


const HOLD_KIND = 'spend-reservation';
const HOLD_STALE_MS = Number(process.env.WALLET_HOLD_STALE_MS || 15 * 60_000);
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * Exact (sub-cent) spendable amount: raw ledger minus payout/affiliate holds.
 * `getAvailableBalance` rounds to cents for display, which can round up by ½¢ and
 * let a metered charge push the ledger below zero.
 */
async function getSpendableBalance(userId) {
  const raw = await getBalance(userId);
  const seller = await getSellerHolds(userId);
  const aff = await getAffiliateHolds(userId).catch(() => ({ held: 0 }));
  return Math.max(0, round6(raw - (Number(seller.held) || 0) - (Number(aff.held) || 0)));
}

function insufficient(summary, need, currency) {
  const err = new Error(
    `Insufficient available wallet balance (need ${need.toFixed(4)} ${currency}, have ${Number(summary.available || 0).toFixed(4)}).`
  );
  err.status = 402;
  err.code = summary.held > 0 ? 'PAYOUT_HELD' : 'INSUFFICIENT_WALLET';
  err.body = { ...summary, amount: need, currency };
  return err;
}

/** Cancel reservations left behind by a crashed request so they stop reducing the balance. */
async function sweepStaleHolds(userId = null, now = new Date()) {
  const q = { type: 'debit', status: 'pending', 'meta.kind': HOLD_KIND, createdAt: { $lt: new Date(now.getTime() - HOLD_STALE_MS) } };
  if (userId) q.user = toObjectId(userId);
  const r = await WalletTx.updateMany(q, { $set: { status: 'cancelled', note: 'Usage hold expired' } }).catch(() => null);
  return r?.modifiedCount || 0;
}

/**
 * Reserve `amount` for an in-flight metered request: a pending debit (counted by
 * getBalance) created under the per-user wallet lock, so parallel requests can never
 * jointly spend more than the wallet holds. Throws 402 when available < amount.
 */
async function placeHold(userId, amount, { currency = 'USD', note = 'Usage hold', meta = {} } = {}) {
  const need = round6(amount);
  if (!(need > 0)) return null;
  const { withWalletLock } = require('./wallet-lock');
  return withWalletLock(userId, async () => {
    await sweepStaleHolds(userId);
    const spendable = await getSpendableBalance(userId);
    if (spendable + 1e-9 < need) {
      const summary = await getAvailableBalance(userId);
      throw insufficient({ ...summary, available: spendable }, need, currency);
    }
    return WalletTx.create({
      user: userId,
      type: 'debit',
      amount: need,
      currency,
      status: 'pending',
      note,
      meta: { ...meta, kind: HOLD_KIND },
    });
  });
}

/** Drop an unused reservation (failed/sandbox/zero-cost run). Never touches a finalized row. */
async function releaseHold(hold) {
  const id = hold?._id || hold;
  if (!id) return;
  await WalletTx.deleteOne({ _id: id, status: 'pending', 'meta.kind': HOLD_KIND }).catch(() => {});
}

module.exports = {
  HOLD_KIND,
  getSpendableBalance,
  placeHold,
  releaseHold,
  sweepStaleHolds,
  MAX_TX_AMOUNT,
  normalizeAmount,
  getBalance,
  getAvailableBalance,
  requireAvailableFunds,
};
