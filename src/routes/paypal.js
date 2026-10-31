const express = require('express');
const WalletTx = require('../models/WalletTx');
const { authenticate } = require('../middleware/auth');
const { mapWallet } = require('../utils/mappers');
const { claimEvent } = require('../finance/idempotency');
const {
  paypalEnabled,
  toPaypalUsd,
  paypalFetch,
  buildCheckoutOrder,
} = require('../utils/paypal-client');
const config = require('../config/env');
const { getExchangeRates, fxAudit } = require('../finance/exchange-rate');

const router = express.Router();

router.get('/config', (_req, res) => {
  const on = paypalEnabled();
  res.json({
    enabled: on,
    clientId: on ? config.paypalClientId : '',
    sandbox: config.paypalSandbox,
    merchantName: 'AI Markets',
  });
});

router.post('/create-order', authenticate, async (req, res, next) => {
  try {
    if (!paypalEnabled()) {
      return res.status(503).json({ message: 'PayPal is not configured', code: 'PAYPAL_NOT_CONFIGURED' });
    }
    const currency = String(req.body?.currency || 'USD').toUpperCase();
    const fx = await getExchangeRates();
    const amountUsd = toPaypalUsd(req.body?.amount, currency, fx.vndPerUsd);
    if (!amountUsd) {
      return res.status(400).json({ message: 'Invalid amount for PayPal (USD or VND)' });
    }

    const note = 'PayPal wallet deposit';

    const tx = await WalletTx.create({
      user: req.user._id,
      type: 'deposit',
      amount: Number(amountUsd),
      currency: 'USD',
      status: 'pending',
      paymentMethod: 'paypal',
      note,
      meta: {
        ...fxAudit(fx),
        inputAmount: Number(req.body?.amount) || 0,
        inputCurrency: currency,
      },
    });

    let order;
    try {
      order = await paypalFetch('/v2/checkout/orders', {
        method: 'POST',
        body: buildCheckoutOrder({
          amountUsd,
          customId: String(tx._id),
          description: `AI Markets wallet ${amountUsd} USD`,
        }),
      });
    } catch (err) {
      tx.status = 'cancelled';
      tx.note = 'PayPal create-order failed';
      await tx.save();
      throw err;
    }

    tx.paypalOrderId = order.id;
    await tx.save();

    res.json({
      success: true,
      orderId: order.id,
      amountUsd,
      paymentHistoryId: String(tx._id),
      approvalUrl: order.links?.find((l) => l.rel === 'approve')?.href || '',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/capture-order', authenticate, async (req, res, next) => {
  try {
    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId) return res.status(400).json({ message: 'orderId required' });

    const { duplicate } = await claimEvent({
      eventId: `paypal_capture_${orderId}`,
      provider: 'paypal',
      kind: 'capture',
    });

    const tx = await WalletTx.findOne({ paypalOrderId: orderId, user: req.user._id });
    if (!tx) return res.status(404).json({ message: 'PayPal deposit not found' });
    if (duplicate && tx.status === 'completed') {
      return res.json({ success: true, duplicate: true, wallet: mapWallet(tx) });
    }

    const captured = await paypalFetch(`/v2/checkout/orders/${orderId}/capture`, { method: 'POST' });
    const ok = captured.status === 'COMPLETED';
    tx.status = ok ? 'completed' : 'failed';
    tx.paypalPayerId = captured.payer?.payer_id || '';
    tx.reviewedAt = new Date();
    if (!ok) tx.note = `PayPal status ${captured.status || 'failed'}`;
    await tx.save();

    res.json({
      success: ok,
      status: captured.status,
      wallet: mapWallet(tx),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
