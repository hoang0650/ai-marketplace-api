const crypto = require('crypto');
const TaxTransaction = require('../models/TaxTransaction');
const TaxWithholding = require('../models/TaxWithholding');

function taxPeriod(date = new Date()) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function recordTaxPostings({ order, settlement }) {
  if (!settlement.taxAmount || settlement.taxAmount <= 0) return { transactions: [], withholdings: [] };
  const period = taxPeriod(order.completedAt || order.createdAt);
  const transactions = [];
  for (const t of settlement.taxBreakdown || []) {
    const taxTransactionId = `tax_${order._id}_${t.type}_${crypto.randomBytes(3).toString('hex')}`;
    transactions.push(
      await TaxTransaction.create({
        taxTransactionId,
        orderId: order._id,
        sellerId: order.seller,
        taxType: t.type,
        taxRate: t.rate,
        taxableAmount: settlement.grossAmount,
        taxAmount: t.amount,
        currency: settlement.currency || order.currency,
        jurisdiction: '',
        taxPeriod: period,
        status: 'FINALIZED',
        kind: 'ORIGINAL',
      }),
    );
    if (settlement.withholdingRequired) {
      await TaxWithholding.create({
        sellerId: order.seller,
        orderId: order._id,
        taxType: t.type,
        taxableAmount: settlement.grossAmount,
        withheldAmount: t.amount,
        currency: settlement.currency || order.currency,
        status: 'WITHHELD',
        taxPeriod: period,
      });
    }
  }
  return { transactions };
}

module.exports = { recordTaxPostings, taxPeriod };
