const WalletTx = require('../models/WalletTx');
const { getSellerHolds, roundMoney } = require('./payout-hold');

const MAX_TX_AMOUNT = 100_000; // sanity cap per transaction (USD)

function normalizeAmount(raw) {
  const amount = Math.round(Number(raw) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_TX_AMOUNT) return null;
  return amount;
}

/** Ledger balance: credits + deposits − debits − withdrawals. */
async function getBalance(userId) {
  const [row] = await WalletTx.aggregate([
    { $match: { user: userId } },
    {
      $group: {
        _id: null,
        balance: {
          $sum: {
            $cond: [{ $in: ['$type', ['credit', 'deposit']] }, '$amount', { $multiply: ['$amount', -1] }],
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
