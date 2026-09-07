const WalletTx = require('../models/WalletTx');
const { getSellerHolds, roundMoney } = require('./payout-hold');

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

/** Ledger minus frozen sale payouts (48h window or open dispute on that order only). */
async function getAvailableBalance(userId) {
  const balance = roundMoney(await getBalance(userId));
  const { held, holds } = await getSellerHolds(userId);
  const available = roundMoney(Math.max(0, balance - held));
  return { balance, held, available, holds };
}

module.exports = { MAX_TX_AMOUNT, normalizeAmount, getBalance, getAvailableBalance };
