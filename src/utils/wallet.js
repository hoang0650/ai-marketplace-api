const WalletTx = require('../models/WalletTx');
const { getSellerHolds, roundMoney } = require('./payout-hold');
const { getAffiliateHolds } = require('../finance/affiliate-service');

const MAX_TX_AMOUNT = 100_000; // sanity cap per transaction (USD)

function normalizeAmount(raw) {
  const amount = Math.round(Number(raw) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_TX_AMOUNT) return null;
  return amount;
}

/** Completed deposits/credits minus completed+pending withdraw/debit (pending withdraw reserves funds). */
async function getBalance(userId) {
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

module.exports = {
  MAX_TX_AMOUNT,
  normalizeAmount,
  getBalance,
  getAvailableBalance,
  requireAvailableFunds,
};
