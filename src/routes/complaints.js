const express = require('express');
const mongoose = require('mongoose');
const Complaint = require('../models/Complaint');
const Order = require('../models/Order');
const { authenticate, requireRoles } = require('../middleware/auth');
const { canOpenDispute } = require('../utils/payout-hold');
const { openOrderDispute } = require('../utils/open-order-dispute');
const { resolveOrderDispute } = require('../utils/resolve-order-dispute');
const {
  caseRefFromId,
  mapComplaint,
  pushEvent,
  parseEvidenceUrls,
  canAccessComplaint,
  notifyUsers,
  notifyAdmins,
  auditComplaint,
} = require('../utils/complaint-helpers');

const router = express.Router();
const KINDS = ['buyer_seller', 'buyer_platform', 'seller_platform'];
const DECISIONS = ['upheld', 'rejected', 'mediated'];

function isId(v) {
  return mongoose.isValidObjectId(v);
}

function relatedFilter(user, as) {
  const uid = user._id;
  if (user.role === 'admin' && as === 'admin') return {};
  if (as === 'seller') return { seller: uid };
  if (as === 'mine') return { complainant: uid };
  return { $or: [{ complainant: uid }, { seller: uid }] };
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const as = String(req.query.as || '').trim();
    const filter = relatedFilter(req.user, as);
    const items = await Complaint.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json(items.map(mapComplaint));
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, async (req, res, next) => {
  try {
    const kind = String(req.body?.kind || '').trim();
    if (!KINDS.includes(kind)) {
      return res.status(400).json({ message: 'kind must be buyer_seller, buyer_platform, or seller_platform' });
    }
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (body.length < 8) {
      return res.status(400).json({ message: 'Please describe the issue (at least 8 characters)' });
    }
    const openCount = await Complaint.countDocuments({
      complainant: req.user._id,
      status: { $nin: ['closed'] },
    });
    if (openCount >= 20) {
      return res.status(429).json({ message: 'Too many open complaints. Wait for existing cases to close.' });
    }

    let order = null;
    if (req.body?.orderId) {
      if (!isId(req.body.orderId)) {
        return res.status(400).json({ message: 'Invalid order ID' });
      }
      order = await Order.findById(req.body.orderId);
      if (!order) return res.status(404).json({ message: 'Order not found' });
      const uid = String(req.user._id);
      if (kind === 'buyer_seller' && String(order.buyer) !== uid) {
        return res.status(403).json({ message: 'Only the buyer can file a buyer–seller complaint on this order' });
      }
      if (kind === 'seller_platform' && String(order.seller) !== uid) {
        return res.status(403).json({ message: 'Only the seller on this order can file a seller–platform complaint' });
      }
    } else if (kind === 'buyer_seller') {
      return res.status(400).json({ message: 'buyer_seller complaints require an order ID' });
    }
    if (kind === 'seller_platform' && req.user.role !== 'creator' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only sellers can file a seller–platform complaint' });
    }

    const wantDispute = req.body?.openOrderDispute !== false;
    let openedOrderDispute = false;
    if (kind === 'buyer_seller' && order && wantDispute && canOpenDispute(order)) {
      await openOrderDispute(order, {
        reason: body,
        actorName: req.user.name,
        href: '/sell/complaints',
      });
      openedOrderDispute = true;
    }

    const complaint = await Complaint.create({
      complainant: req.user._id,
      complainantName: String(req.body?.name || req.user.name || '').trim().slice(0, 200) || req.user.name,
      complainantEmail: String(req.body?.email || req.user.email || '').trim().slice(0, 200) || req.user.email,
      kind,
      order: order?._id || null,
      product: order?.product || (isId(req.body?.productId) ? req.body.productId : null),
      productName: String(req.body?.productName || order?.productName || '').trim().slice(0, 300),
      seller: kind === 'buyer_seller' ? order?.seller || null : null,
      body,
      requestedAction: String(req.body?.requestedAction || '').trim().slice(0, 1000),
      evidenceUrls: parseEvidenceUrls(req.body?.evidenceUrls),
      status: 'received',
      openedOrderDispute,
      events: [
        {
          at: new Date(),
          actorId: req.user._id,
          actorRole: req.user.role,
          action: 'received',
          note: openedOrderDispute ? 'Order payout frozen (48h dispute).' : '',
        },
      ],
    });
    complaint.caseRef = caseRefFromId(complaint._id);
    await complaint.save();

    await notifyAdmins({
      title: `Khiếu nại ${complaint.caseRef}`,
      body: `${complaint.complainantName} opened a ${kind} case.`,
      href: `/admin/complaints/${complaint._id}`,
    });
    if (complaint.seller) {
      await notifyUsers([complaint.seller], {
        title: `Khiếu nại ${complaint.caseRef}`,
        body: `${complaint.complainantName} filed a complaint about ${complaint.productName || 'an order'}.`,
        href: '/sell/complaints',
      });
    }
    await auditComplaint(req, 'complaint.create', complaint, { kind, openedOrderDispute });

    res.status(201).json(mapComplaint(complaint));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ message: 'Complaint not found' });
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ message: 'Complaint not found' });
    if (!canAccessComplaint(req.user, complaint)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    res.json(mapComplaint(complaint));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/seller-response', authenticate, async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ message: 'Complaint not found' });
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ message: 'Complaint not found' });
    if (String(complaint.seller) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only the seller on this case can respond' });
    }
    if (complaint.status !== 'awaiting_seller') {
      return res.status(400).json({ message: 'Seller response is only allowed while the case awaits seller reply' });
    }
    const text = String(req.body?.body || '').trim().slice(0, 4000);
    if (text.length < 8) {
      return res.status(400).json({ message: 'Please describe your response (at least 8 characters)' });
    }
    complaint.sellerResponse = text;
    complaint.sellerRespondedAt = new Date();
    complaint.status = 'reviewing';
    pushEvent(complaint, req, 'seller_response', text.slice(0, 200));
    await complaint.save();
    await notifyUsers([complaint.complainant], {
      title: `${complaint.caseRef}: seller replied`,
      body: 'The seller submitted a response. The platform is reviewing evidence.',
      href: `/complaints/${complaint._id}`,
    });
    await notifyAdmins({
      title: `${complaint.caseRef}: seller replied`,
      body: 'Seller response received. Case moved to evidence review.',
      href: `/admin/complaints/${complaint._id}`,
    });
    await auditComplaint(req, 'complaint.seller_response', complaint);
    res.json(mapComplaint(complaint));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/appeal', authenticate, async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ message: 'Complaint not found' });
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ message: 'Complaint not found' });
    if (String(complaint.complainant) !== String(req.user._id) && req.user.role !== 'admin') {
      if (String(complaint.seller) !== String(req.user._id)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }
    if (complaint.status !== 'decided') {
      return res.status(400).json({ message: 'Appeal is only allowed after a decision' });
    }
    if (complaint.appealedAt) {
      return res.status(400).json({ message: 'This case has already been appealed' });
    }
    const reason = String(req.body?.reason || '').trim().slice(0, 2000);
    if (reason.length < 8) {
      return res.status(400).json({ message: 'Please describe why you want a review (at least 8 characters)' });
    }
    complaint.appealReason = reason;
    complaint.appealedAt = new Date();
    complaint.status = 'reviewing';
    pushEvent(complaint, req, 'appeal', reason.slice(0, 200));
    await complaint.save();
    await notifyAdmins({
      title: `${complaint.caseRef}: appeal`,
      body: `${req.user.name} requested an internal review.`,
      href: `/admin/complaints/${complaint._id}`,
    });
    await auditComplaint(req, 'complaint.appeal', complaint, { reason });
    res.json(mapComplaint(complaint));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ message: 'Complaint not found' });
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ message: 'Complaint not found' });
    const action = String(req.body?.action || '').trim();
    const note = String(req.body?.note || '').trim().slice(0, 2000);

    if (action === 'advance') {
      const next =
        complaint.status === 'received'
          ? 'verifying'
          : complaint.status === 'verifying'
            ? 'classified'
            : complaint.status === 'classified'
              ? complaint.kind === 'buyer_seller'
                ? 'awaiting_seller'
                : 'reviewing'
              : complaint.status === 'awaiting_seller'
                ? 'reviewing'
                : null;
      if (!next) {
        return res.status(400).json({ message: 'Cannot advance this case from the current status' });
      }
      complaint.status = next;
      pushEvent(complaint, req, next, note);
      await complaint.save();
      if (next === 'awaiting_seller' && complaint.seller) {
        await notifyUsers([complaint.seller], {
          title: `${complaint.caseRef}: phản hồi seller`,
          body: 'The platform asked you to respond to this complaint.',
          href: `/complaints/${complaint._id}`,
        });
      }
    } else if (action === 'skip_seller') {
      if (complaint.status !== 'awaiting_seller' && complaint.status !== 'classified') {
        return res.status(400).json({ message: 'Can only skip seller reply from classified / awaiting_seller' });
      }
      complaint.status = 'reviewing';
      pushEvent(complaint, req, 'skip_seller', note);
      await complaint.save();
    } else if (action === 'decide') {
      if (complaint.status !== 'reviewing' && complaint.status !== 'awaiting_seller') {
        return res.status(400).json({ message: 'Decide is only allowed during evidence review' });
      }
      const decision = String(req.body?.decision || '').trim();
      if (!DECISIONS.includes(decision)) {
        return res.status(400).json({ message: 'decision must be upheld, rejected, or mediated' });
      }
      const decisionNote = String(req.body?.decisionNote || note || '').trim().slice(0, 2000);
      complaint.decision = decision;
      complaint.decisionNote = decisionNote;
      complaint.decidedAt = new Date();
      complaint.status = 'decided';
      pushEvent(complaint, req, 'decided', decisionNote);

      if (complaint.openedOrderDispute && complaint.order) {
        const order = await Order.findById(complaint.order);
        if (order && order.disputeStatus === 'open') {
          if (decision === 'upheld') {
            await resolveOrderDispute(order, {
              resolution: 'buyer',
              note: decisionNote || complaint.caseRef,
              actorId: req.user._id,
            });
          } else if (decision === 'rejected') {
            await resolveOrderDispute(order, {
              resolution: 'seller',
              note: decisionNote || complaint.caseRef,
              actorId: req.user._id,
            });
          }
        }
      }
      await complaint.save();
      await notifyUsers([complaint.complainant, complaint.seller].filter(Boolean), {
        title: `${complaint.caseRef}: quyết định`,
        body: `Decision: ${decision}. ${decisionNote}`.slice(0, 400),
        href: `/complaints/${complaint._id}`,
      });
    } else if (action === 'close') {
      if (complaint.status !== 'decided') {
        return res.status(400).json({ message: 'Close is only allowed after a decision' });
      }
      complaint.status = 'closed';
      complaint.closedAt = new Date();
      pushEvent(complaint, req, 'closed', note);
      await complaint.save();
    } else {
      return res.status(400).json({ message: 'action must be advance, skip_seller, decide, or close' });
    }

    await auditComplaint(req, `complaint.${action}`, complaint, { note });
    res.json(mapComplaint(complaint));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
