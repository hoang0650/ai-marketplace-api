const mongoose = require('mongoose');
const WalletTx = require('../models/WalletTx');
const AffiliateCommission = require('../models/AffiliateCommission');
const { getSellerHolds, roundMoney } = require('./payout-hold');
const { getAffiliateHolds, getAffiliateBalance } = require('../finance/affiliate-service');
const {
  COMMISSION_BANK_ONLY_CODE,
  COMMISSION_BANK_ONLY_MESSAGE,
} = require('../finance/affiliate-use-policy');

const MAX_TX_AMOUNT = 100_000; // sanity cap per transaction (USD)
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
/** Captured before unit tests replace the model method. A disconnected process must not buffer a real query. */
const originalCommissionFind = AffiliateCommission.find;

/**
 * Commission rows are readable when Mongo is connected, or when a test has
 * replaced the finder. Otherwise there is nothing to subtract and we must not
 * wait on a buffered command.
 */
function commissionRecordsReadable() {
  if (mongoose.connection.readyState === 1) return true;
  return AffiliateCommission.find !== originalCommissionFind;
}

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

/**
 * Ledger parts for one user.
 * `payoutAvailable` is the ledger minus seller and affiliate holds (48h or an open dispute).
 * `available` / `spendable` also exclude released affiliate commission. That balance can
 * leave only as a bank payout to the affiliate's registered account.
 */
async function loadBalanceParts(userId) {
  const raw = await getBalance(userId);
  const seller = await getSellerHolds(userId);
  let aff = { held: 0, holds: [] };
  let released = 0;
  let commissionKnown = true;
  if (commissionRecordsReadable()) {
    aff = await getAffiliateHolds(userId).catch(() => ({ held: 0, holds: [] }));
    try {
      const slice = await getAffiliateBalance(userId);
      released = Math.max(0, Number(slice?.available) || 0);
      aff = { ...aff, held: Math.max(Number(aff.held) || 0, Number(slice?.held) || 0) };
    } catch {
      // Connected, but the commission slice could not be separated from the ledger.
      commissionKnown = false;
    }
  }
  const sellerHeld = Number(seller.held) || 0;
  const affHeld = Number(aff.held) || 0;
  const held = roundMoney(sellerHeld + affHeld);
  const balance = roundMoney(raw);
  const payoutRaw = Math.max(0, round6(raw - sellerHeld - affHeld));
  const payoutAvailable = roundMoney(payoutRaw);
  const spendable = commissionKnown ? Math.max(0, round6(payoutRaw - released)) : 0;
  const available = commissionKnown ? roundMoney(Math.max(0, payoutAvailable - roundMoney(released))) : 0;
  return {
    balance,
    held,
    available,
    holds: [...(seller.holds || []), ...(aff.holds || [])],
    payoutAvailable,
    payoutRaw,
    affiliateReleased: roundMoney(released),
    spendable,
    commissionKnown,
  };
}

/** Ledger minus frozen sale payouts. `available` is the purchase spendable balance. */
async function getAvailableBalance(userId) {
  return loadBalanceParts(userId);
}

/**
 * Reject a purchase that would spend affiliate commission.
 * A shortfall the non-commission balance cannot cover is the ordinary 402.
 */
function purchaseFundsError({ need, summary, currency = 'USD' } = {}) {
  const spendable = Number(summary?.spendable);
  const have = Number.isFinite(spendable) ? spendable : Number(summary?.available) || 0;
  if (have + 1e-9 >= need) return null;
  const pool = Number(summary?.payoutRaw ?? summary?.payoutAvailable) || 0;
  if (summary?.commissionKnown && pool + 1e-9 >= need) {
    const err = new Error(COMMISSION_BANK_ONLY_MESSAGE);
    err.status = 403;
    err.code = COMMISSION_BANK_ONLY_CODE;
    err.body = { ...summary, available: have, amount: need, currency };
    return err;
  }
  const shown = roundMoney(have);
  const err = new Error(
    summary?.held > 0
      ? `Insufficient available balance. Ledger ${Number(summary.balance || 0).toFixed(2)}, held ${Number(summary.held || 0).toFixed(2)} (48h protection or open dispute), available ${shown.toFixed(2)}.`
      : `Insufficient internal ledger entitlement (need ${need.toFixed(2)} ${currency}, have ${shown.toFixed(2)}).`,
  );
  err.status = 402;
  err.code = summary?.held > 0 ? 'PAYOUT_HELD' : 'INSUFFICIENT_WALLET';
  err.body = { ...summary, available: have, amount: need, currency };
  return err;
}

/** Spend / checkout must use available funds so holds and affiliate commission stay reserved. */
async function requireAvailableFunds(userId, amount, { currency = 'USD' } = {}) {
  const need = Number(amount) || 0;
  const summary = await getAvailableBalance(userId);
  if (need <= 0) return summary;
  const err = purchaseFundsError({ need, summary, currency });
  if (err) throw err;
  return summary;
}


const HOLD_KIND = 'spend-reservation';
const HOLD_STALE_MS = Number(process.env.WALLET_HOLD_STALE_MS || 15 * 60_000);

/**
 * Exact (sub-cent) amount a purchase may debit: raw ledger minus seller holds,
 * affiliate holds, and released affiliate commission.
 * Rounding `available` to cents can round up by ½¢ and let a metered charge
 * push the ledger below zero, so callers that debit use this figure.
 */
async function getSpendableBalance(userId) {
  const summary = await getAvailableBalance(userId);
  return summary.spendable;
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
 * jointly spend more than the wallet holds. Throws 402 when available < amount,
 * or 403 when the shortfall is affiliate commission.
 */
async function placeHold(userId, amount, { currency = 'USD', note = 'Usage hold', meta = {} } = {}) {
  const need = round6(amount);
  if (!(need > 0)) return null;
  const { withWalletLock } = require('./wallet-lock');
  return withWalletLock(userId, async () => {
    await sweepStaleHolds(userId);
    const summary = await getAvailableBalance(userId);
    if (summary.spendable + 1e-9 < need) {
      const err = purchaseFundsError({ need, summary, currency });
      if (err) throw err;
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
  purchaseFundsError,
};
