const express = require('express');
const Order = require('../models/Order');
const { authenticate } = require('../middleware/auth');
const { hasCapability } = require('../utils/roles');
const { mapOrder } = require('../utils/mappers');
const { openOrderDispute } = require('../utils/open-order-dispute');

const mongoose = require('mongoose');
const User = require('../models/User');
const OrderInvoice = require('../models/OrderInvoice');
const { ensureOrderInvoice } = require('../finance/invoice-service');
const { parseInvoiceChoice, invoicePrefill, isEditable, mapInvoice } = require('../utils/invoice');

const router = express.Router();

async function loadBuyerOrder(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ message: 'Invalid order id' });
    return null;
  }
  const order = await Order.findById(req.params.id).lean();
  if (!order) {
    res.status(404).json({ message: 'Order not found' });
    return null;
  }
  if (String(order.buyer) !== String(req.user._id) && req.user.role !== 'admin') {
    res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' });
    return null;
  }
  return order;
}

/** GET /v1/orders/:id/invoice — the order's invoice record + prefill (buyer or admin). */
router.get('/:id/invoice', authenticate, async (req, res, next) => {
  try {
    const order = await loadBuyerOrder(req, res);
    if (!order) return;
    const inv = order.status === 'paid' || order.status === 'refunded' ? await ensureOrderInvoice(order) : null;
    const user = await User.findById(order.buyer).select('name email kyc invoiceProfile').lean();
    res.json({
      order: { id: String(order._id), productName: order.productName, amount: order.amount, currency: order.currency || 'USD', status: order.status, createdAt: order.createdAt },
      invoice: mapInvoice(inv),
      prefill: invoicePrefill(user),
      hasSavedProfile: Boolean(user?.invoiceProfile?.buyerType),
    });
  } catch (err) {
    next(err);
  }
});

/** PUT /v1/orders/:id/invoice — buyer sets the choice; allowed until the end of the purchase day and before issue. */
router.put('/:id/invoice', authenticate, async (req, res, next) => {
  try {
    const order = await loadBuyerOrder(req, res);
    if (!order) return;
    if (String(order.buyer) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only the buyer can change the invoice choice', code: 'FORBIDDEN' });
    }
    if (order.status !== 'paid') {
      return res.status(400).json({ message: 'Invoice choice is only available for paid orders', code: 'ORDER_NOT_PAID' });
    }
    const inv = await ensureOrderInvoice(order);
    if (!isEditable(inv)) {
      return res.status(409).json({
        message: inv.status === 'issued' ? 'The invoice has already been issued' : 'The invoice choice can no longer be changed',
        code: inv.status === 'issued' ? 'INVOICE_ISSUED' : 'INVOICE_LOCKED',
        invoice: mapInvoice(inv),
      });
    }
    const parsed = parseInvoiceChoice(req.body);
    if (!parsed.ok) return res.status(400).json({ message: parsed.message, code: parsed.code });
    Object.assign(inv, parsed.data, { choiceUpdatedAt: new Date() });
    await inv.save();
    if (req.body?.saveProfile === true && parsed.data.wantsInvoice) {
      const { wantsInvoice, ...profile } = parsed.data;
      await User.updateOne({ _id: req.user._id }, { $set: { invoiceProfile: { ...profile, updatedAt: new Date() } } });
    }
    res.json({ ok: true, invoice: mapInvoice(inv) });
  } catch (err) {
    next(err);
  }
});

/** GET /v1/orders/:id/invoice/pdf — short-lived signed link to the issued invoice PDF. */
router.get('/:id/invoice/pdf', authenticate, async (req, res, next) => {
  try {
    const order = await loadBuyerOrder(req, res);
    if (!order) return;
    const inv = await OrderInvoice.findOne({ order: order._id }).lean();
    if (!inv?.pdfObjectName) return res.status(404).json({ message: 'No invoice PDF yet', code: 'NO_PDF' });
    const { getKycPresignedUrl } = require('../config/minio');
    const url = await getKycPresignedUrl(inv.pdfObjectName, 900);
    res.json({ url, expiresIn: 900 });
  } catch (err) {
    next(err);
  }
});


router.get('/', authenticate, async (req, res, next) => {
  try {
    const filter =
      req.user.role === 'admin'
        ? {}
        : hasCapability(req.user, 'orderSeller')
          ? { $or: [{ seller: req.user._id }, { buyer: req.user._id }] }
          : { buyer: req.user._id };
    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean();
    res.json(orders.map((o) => mapOrder(o, { viewerId: req.user._id, viewerRole: req.user.role })));
  } catch (err) {
    next(err);
  }
});

router.get('/disputes', authenticate, async (req, res, next) => {
  try {
    const filter =
      req.user.role === 'admin'
        ? { disputeStatus: { $ne: 'none' } }
        : {
            disputeStatus: { $ne: 'none' },
            $or: [{ buyer: req.user._id }, { seller: req.user._id }],
          };
    const orders = await Order.find(filter).sort({ disputeOpenedAt: -1, createdAt: -1 }).lean();
    res.json(orders.map((o) => mapOrder(o, { viewerId: req.user._id, viewerRole: req.user.role })));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/dispute', authenticate, async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (String(order.buyer) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only the buyer can open a dispute on this order' });
    }
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    try {
      await openOrderDispute(order, {
        reason,
        actorName: req.user.name,
        href: '/sell/complaints',
      });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ message: err.message, code: err.code });
      }
      throw err;
    }

    res.json(mapOrder(order, { viewerId: req.user._id, viewerRole: req.user.role }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
