const WalletTx = require('../models/WalletTx');

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

module.exports = { MAX_TX_AMOUNT, normalizeAmount, getBalance };
