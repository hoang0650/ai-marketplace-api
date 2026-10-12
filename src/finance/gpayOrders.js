const { detectWebhookKind } = require('../utils/gpay-client');
const { DEFAULT_VND_PER_USD } = require('../config/fx');

const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;

const FAILED_STATUSES = new Set(['ORDER_FAILED', 'ORDER_CANCEL']);

/**
 * Our GPay order id: gateway request_id / QR bill_id. The `AIM` prefix routes webhooks here.
 * GPay rejects QR bill_id longer than 24 chars (despite the documented 50), so the
 * ObjectId is base36-encoded: at most 3 + 19 = 22 chars.
 */
function orderRequestId(txId) {
  return `AIM${BigInt(`0x${String(txId)}`).toString(36).toUpperCase()}`;
}

/**
 * Normalise a gateway / QR webhook (or bill-info response) into
 * { kind, requestId, outcome: 'success' | 'failed' | 'pending', gpayTransId, paidVnd }.
 * Returns null for Virtual Account payloads.
 */
function resolveOrderEvent(payload = {}) {
  const kind = detectWebhookKind(payload);
  if (kind === 'portal') {
    const status = String(payload.status || '').trim().toUpperCase();
    return {
      kind,
      requestId: String(payload.merchant_order_id || '').trim(),
      outcome: status === 'ORDER_SUCCESS' ? 'success' : FAILED_STATUSES.has(status) ? 'failed' : 'pending',
      status,
      gpayTransId: String(payload.gpay_trans_id || payload.gpay_bill_id || '').trim(),
      paidVnd: 0,
      userPaymentMethod: String(payload.user_payment_method || ''),
    };
  }
  if (kind === 'qr') {
    return {
      kind,
      requestId: String(payload.bill_id || '').trim(),
      outcome: 'success',
      status: 'PAID',
      gpayTransId: String(payload.gpay_trans_id || payload.bank_transaction_id || '').trim(),
      paidVnd: Number(payload.amount) || 0,
      userPaymentMethod: String(payload.source_of_fund || 'VIETQR'),
    };
  }
  return null;
}

/**
 * Apply a gateway / QR event to its pending WalletTx deposit (idempotent).
 * @returns {Promise<{status: number, body: object}>}
 */
async function settleOrderEvent(event, { WalletTx, vndPerUsd, mapWallet = (t) => t }) {
  if (!event.requestId) {
    return { status: 400, body: { message: 'Missing GPay order id', code: 'GPAY_NO_ORDER' } };
  }
  const tx = await WalletTx.findOne({ gpayRequestId: event.requestId });
  if (!tx) return { status: 404, body: { message: 'Unknown GPay order', code: 'GPAY_UNKNOWN_ORDER' } };
  if (tx.status === 'completed') {
    return { status: 200, body: { success: true, duplicate: true, wallet: mapWallet(tx) } };
  }

  if (event.outcome === 'pending') {
    return { status: 200, body: { success: true, status: event.status } };
  }
  if (event.outcome === 'failed') {
    await WalletTx.updateOne(
      { _id: tx._id, status: 'pending' },
      { $set: { status: event.status === 'ORDER_CANCEL' ? 'cancelled' : 'failed', 'meta.gpayStatus': event.status } },
    );
    return { status: 200, body: { success: true, status: event.status } };
  }

  // QR reports the amount actually transferred; the gateway charges exactly the bill amount.
  const rate = Number(vndPerUsd) > 0 ? Number(vndPerUsd) : DEFAULT_VND_PER_USD;
  const billedVnd = Number(tx.meta?.amountVnd) || 0;
  const paidVnd = event.paidVnd > 0 ? event.paidVnd : billedVnd;
  const amountUsd = paidVnd === billedVnd ? tx.amount : roundMoney(paidVnd / rate);
  if (!(amountUsd > 0)) {
    return { status: 400, body: { message: 'Deposit amount rounds to zero', code: 'GPAY_BAD_AMOUNT' } };
  }

  let updated;
  try {
    // A late success after a failed/cancelled status still means money arrived.
    updated = await WalletTx.findOneAndUpdate(
      { _id: tx._id, status: { $in: ['pending', 'failed', 'cancelled'] } },
      {
        $set: {
          status: 'completed',
          amount: amountUsd,
          gpayTransactionId: event.gpayTransId || event.requestId,
          reviewedAt: new Date(),
          'meta.paidVnd': paidVnd,
          'meta.gpayStatus': event.status,
          'meta.userPaymentMethod': event.userPaymentMethod,
        },
      },
      { new: true },
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  const final = updated || (await WalletTx.findById(tx._id));
  return {
    status: 200,
    body: { success: true, duplicate: !updated, creditedUsd: final?.amount, wallet: final ? mapWallet(final) : null },
  };
}

module.exports = { orderRequestId, resolveOrderEvent, settleOrderEvent, roundMoney };
