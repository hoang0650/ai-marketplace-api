const crypto = require('crypto');
const Chargeback = require('../models/Chargeback');
const WalletTx = require('../models/WalletTx');
const { recordAdjustmentLines, newEntryId } = require('./ledger-service');
const { writeAuditLog } = require('../utils/audit');
const { roundMoney } = require('./constants');

async function createChargeback({ order, amount, feeAmount = 0, reason = '', actorId = null }) {
  const gross = roundMoney(amount);
  const fee = roundMoney(feeAmount);
  const chargebackId = `cb_${crypto.randomBytes(8).toString('hex')}`;

  const extra = [
    {
      entryId: newEntryId('cb'),
      type: 'CHARGEBACK',
      amount: gross,
      direction: 'debit',
      reference: `chargeback:${chargebackId}`,
    },
  ];
  if (fee > 0) {
    extra.push({
      entryId: newEntryId('cbfee'),
      type: 'PAYMENT_PROCESSING_FEE',
      amount: fee,
      direction: 'debit',
      reference: `chargeback:${chargebackId}:fee`,
    });
  }

  const doc = await Chargeback.create({
    chargebackId,
    orderId: order._id,
    amount: gross,
    feeAmount: fee,
    currency: order.currency || 'USD',
    reason,
    status: 'OPEN',
    createdBy: actorId,
  });

  await recordAdjustmentLines({ order, extra });

  if (order.ownershipType === 'THIRD_PARTY_SELLER') {
    const clawback = roundMoney((Number(order.sellerNet) || 0) > 0 ? Math.min(Number(order.sellerNet), gross) : gross);
    if (clawback > 0) {
      await WalletTx.create({
        user: order.seller,
        type: 'debit',
        amount: clawback,
        currency: order.currency || 'USD',
        note: `Chargeback ${chargebackId} order ${order._id}`,
      });
    }
  }

  await writeAuditLog({
    actorId,
    action: 'CHARGEBACK_CREATED',
    resourceType: 'Chargeback',
    resourceId: chargebackId,
    newValue: { orderId: String(order._id), amount: gross, feeAmount: fee },
    reason,
  });

  return doc;
}

module.exports = { createChargeback };
