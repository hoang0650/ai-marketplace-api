const express = require('express');
const Order = require('../models/Order');
const { authenticate, requireRoles } = require('../middleware/auth');
const { createRefund } = require('../finance/refund-service');
const { createChargeback } = require('../finance/chargeback-service');
const { claimEvent } = require('../finance/idempotency');

const router = express.Router();

router.post('/webhook', async (req, res, next) => {
  try {
    const eventId = String(req.body?.eventId || req.headers['x-payment-event-id'] || '').trim();
    const provider = String(req.body?.provider || 'internal').slice(0, 40);
    if (!eventId) {
      return res.status(400).json({ message: 'eventId required' });
    }
    const { duplicate } = await claimEvent({
      eventId,
      provider,
      kind: 'webhook',
      orderId: req.body?.orderId || null,
    });
    if (duplicate) {
      return res.json({ ok: true, duplicate: true });
    }
    res.json({ ok: true, duplicate: false, note: 'Provider confirms payment only; commission/tax/payout stay on backend.' });
  } catch (err) {
    next(err);
  }
});

router.post('/refunds', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const order = await Order.findById(req.body?.orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const result = await createRefund({
      order,
      amount: Number(req.body?.amount != null ? req.body.amount : order.amount),
      reason: String(req.body?.reason || ''),
      actorId: req.user._id,
      eventId: req.body?.eventId || null,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/chargebacks', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const order = await Order.findById(req.body?.orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const doc = await createChargeback({
      order,
      amount: Number(req.body?.amount != null ? req.body.amount : order.amount),
      feeAmount: Number(req.body?.feeAmount) || 0,
      reason: String(req.body?.reason || ''),
      actorId: req.user._id,
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
