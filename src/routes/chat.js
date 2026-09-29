const express = require('express');
const Product = require('../models/Product');
const JobPosting = require('../models/JobPosting');
const TalentProfile = require('../models/TalentProfile');
const JobApplication = require('../models/JobApplication');
const Conversation = require('../models/Conversation');
const ChatMessage = require('../models/ChatMessage');
const { notifyUser } = require('../utils/notify');
const { authenticate } = require('../middleware/auth');
const { containsBlockedLink, isAllowedChatImageUrl } = require('../utils/chat-security');
const { ensureTalentUser } = require('../utils/ensure-talent-user');

const router = express.Router();
const MAX_BODY = 2000;
const MAX_PER_HOUR = 80;

function userName(u) {
  if (!u) return '';
  if (typeof u === 'object') return String(u.name || u.email || '').trim();
  return '';
}

function mapMessage(doc) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  return {
    id: String(o._id || o.id),
    conversationId: String(o.conversation),
    senderId: String(o.sender?._id || o.sender),
    kind: o.kind || 'text',
    body: o.body || '',
    imageUrl: o.imageUrl || '',
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
  };
}

function mapConversation(doc, meId) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  const buyerId = String(o.buyer?._id || o.buyer);
  const sellerId = String(o.seller?._id || o.seller);
  const isBuyer = buyerId === String(meId);
  const other = isBuyer ? o.seller : o.buyer;
  const contextType = o.contextType || (o.job ? 'job' : o.talentSlug ? 'talent' : 'product');
  const title =
    contextType === 'job'
      ? o.jobTitle || 'Work job'
      : contextType === 'talent'
        ? o.talentSlug || 'Talent'
        : o.productName || o.product?.name || '';
  return {
    id: String(o._id || o.id),
    contextType,
    productId: String(o.product?._id || o.product || ''),
    productName: o.productName || o.product?.name || '',
    productSlug: o.productSlug || o.product?.slug || '',
    productCover: o.productCover || o.product?.coverUrl || '',
    jobId: String(o.job?._id || o.job || ''),
    jobTitle: o.jobTitle || '',
    jobSlug: o.jobSlug || '',
    talentSlug: o.talentSlug || '',
    title,
    role: isBuyer ? 'buyer' : 'seller',
    otherId: isBuyer ? sellerId : buyerId,
    otherName: userName(other) || (isBuyer ? 'Seller' : 'Buyer'),
    lastMessage: o.lastMessage || '',
    lastKind: o.lastKind || 'text',
    lastMessageAt: o.lastMessageAt ? new Date(o.lastMessageAt).toISOString() : null,
    unread: isBuyer ? Number(o.buyerUnread) || 0 : Number(o.sellerUnread) || 0,
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : null,
  };
}

function assertMember(convo, userId) {
  const buyerId = String(convo.buyer?._id || convo.buyer);
  const sellerId = String(convo.seller?._id || convo.seller);
  const me = String(userId);
  if (buyerId !== me && sellerId !== me) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return { buyerId, sellerId, isBuyer: buyerId === me };
}

async function parsePayload(body) {
  const text = String(body?.body || '').trim().slice(0, MAX_BODY);
  const imageUrl = String(body?.imageUrl || '').trim();
  if (containsBlockedLink(text)) {
    const err = new Error('Links are not allowed in chat for security.');
    err.status = 400;
    err.code = 'LINKS_NOT_ALLOWED';
    throw err;
  }
  if (imageUrl && !isAllowedChatImageUrl(imageUrl)) {
    const err = new Error('Only images uploaded on AI Markets can be sent.');
    err.status = 400;
    err.code = 'IMAGE_HOST_NOT_ALLOWED';
    throw err;
  }
  if (!text && !imageUrl) {
    const err = new Error('Message text or image is required');
    err.status = 400;
    throw err;
  }
  return { text, imageUrl, kind: imageUrl ? 'image' : 'text' };
}

async function assertRate(userId) {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const n = await ChatMessage.countDocuments({ sender: userId, createdAt: { $gte: since } });
  if (n >= MAX_PER_HOUR) {
    const err = new Error('Too many messages. Please wait before sending more.');
    err.status = 429;
    err.code = 'CHAT_RATE_LIMIT';
    throw err;
  }
}

async function appendMessage(convo, senderId, { text, imageUrl, kind }) {
  const msg = await ChatMessage.create({
    conversation: convo._id,
    sender: senderId,
    kind,
    body: text,
    imageUrl,
  });
  const preview = kind === 'image' ? (text ? `[image] ${text}` : '[image]') : text;
  const buyerId = String(convo.buyer?._id || convo.buyer);
  const sellerId = String(convo.seller?._id || convo.seller);
  const isBuyer = buyerId === String(senderId);
  convo.lastMessage = preview.slice(0, 240);
  convo.lastKind = kind;
  convo.lastMessageAt = new Date();
  if (isBuyer) convo.sellerUnread = (convo.sellerUnread || 0) + 1;
  else convo.buyerUnread = (convo.buyerUnread || 0) + 1;
  await convo.save();

  const recipient = isBuyer ? sellerId : buyerId;
  const label =
    convo.contextType === 'job'
      ? convo.jobTitle || 'Work'
      : convo.contextType === 'talent'
        ? convo.talentSlug || 'Talent'
        : convo.productName || 'Sản phẩm';
  await notifyUser(
    recipient,
    'chat.newMessage',
    { sender: label, preview: preview.slice(0, 240) },
    isBuyer ? `/sell/messages/${convo._id}` : `/messages/${convo._id}`,
  ).catch(() => {});
  return msg;
}

async function upsertConversation(query, defaults) {
  let convo = await Conversation.findOne(query);
  if (!convo) {
    try {
      convo = await Conversation.create({ ...query, ...defaults, lastMessageAt: new Date() });
    } catch (err) {
      if (err.code !== 11000) throw err;
      convo = await Conversation.findOne(query);
    }
  }
  return convo;
}

router.get('/conversations', authenticate, async (req, res, next) => {
  try {
    const rows = await Conversation.find({
      $or: [{ buyer: req.user._id }, { seller: req.user._id }],
    })
      .populate('buyer', 'name email')
      .populate('seller', 'name email')
      .sort({ lastMessageAt: -1 })
      .limit(200)
      .lean({ virtuals: true });
    res.json(rows.map((r) => mapConversation(r, req.user._id)));
  } catch (err) {
    next(err);
  }
});

router.post('/conversations', authenticate, async (req, res, next) => {
  try {
    const productId = String(req.body?.productId || '').trim();
    const jobId = String(req.body?.jobId || '').trim();
    const jobSlug = String(req.body?.jobSlug || '').trim().toLowerCase();
    const talentSlug = String(req.body?.talentSlug || '').trim().toLowerCase();
    const applicationId = String(req.body?.applicationId || '').trim();

    let convo;

    if (jobId || jobSlug || applicationId) {
      let job = null;
      let application = null;
      if (applicationId) {
        application = await JobApplication.findById(applicationId);
        if (!application) return res.status(404).json({ message: 'Application not found' });
        job = await JobPosting.findById(application.job);
      } else if (jobId) {
        job = await JobPosting.findById(jobId);
      } else {
        job = await JobPosting.findOne({ slug: jobSlug });
      }
      if (!job) return res.status(404).json({ message: 'Job not found' });
      const employerId = job.postedBy && (job.postedBy._id || job.postedBy);
      if (!employerId) return res.status(400).json({ message: 'Job has no employer' });

      const me = String(req.user._id);
      const emp = String(employerId);
      let applicantId;
      let sellerId = emp;
      let buyerId;

      if (me === emp) {
        // Employer messaging an applicant
        applicantId = application
          ? String(application.applicant)
          : String(req.body?.applicantId || '').trim();
        if (!applicantId) return res.status(400).json({ message: 'applicantId required' });
        buyerId = applicantId;
      } else {
        // Applicant messaging employer — ensure application exists
        buyerId = me;
        applicantId = me;
        if (!application) {
          application = await JobApplication.findOne({ job: job._id, applicant: me });
        }
        if (!application) {
          return res.status(400).json({
            message: 'Apply with a proposed price before chatting with the employer',
            code: 'APPLY_FIRST',
          });
        }
      }

      if (buyerId === sellerId) {
        return res.status(400).json({ message: 'Invalid chat parties', code: 'CHAT_SELF' });
      }

      convo = await upsertConversation(
        { buyer: buyerId, seller: sellerId, job: job._id },
        {
          contextType: 'job',
          jobTitle: job.title,
          jobSlug: job.slug,
          product: null,
        },
      );

      if (application && !application.conversation) {
        application.conversation = convo._id;
        await application.save();
      }

      const seed =
        String(req.body?.body || '').trim() ||
        (application && me !== emp
          ? `Xin chào, tôi đề xuất ${Number(application.proposedAmount).toLocaleString()} ${application.proposedCurrency}/${application.proposedPeriod}.`
          : '');
      if (seed || String(req.body?.imageUrl || '').trim()) {
        await assertRate(req.user._id);
        const payload = seed
          ? await parsePayload({ body: seed, imageUrl: req.body?.imageUrl })
          : await parsePayload(req.body);
        await appendMessage(convo, req.user._id, payload);
      }
    } else if (talentSlug) {
      const talent = await TalentProfile.findOne({ slug: talentSlug });
      if (!talent) return res.status(404).json({ message: 'Talent not found' });
      const talentUserId = await ensureTalentUser(talent);
      if (!talentUserId) {
        return res.status(500).json({ message: 'Could not link talent account for chat' });
      }
      if (String(talentUserId) === String(req.user._id)) {
        return res.status(400).json({ message: 'You cannot chat with yourself', code: 'CHAT_SELF' });
      }
      convo = await upsertConversation(
        {
          buyer: req.user._id,
          seller: talentUserId,
          contextType: 'talent',
          talentSlug: talent.slug,
        },
        {
          contextType: 'talent',
          talentSlug: talent.slug,
          product: null,
          job: null,
        },
      );
      const hasContent = String(req.body?.body || '').trim() || String(req.body?.imageUrl || '').trim();
      if (hasContent) {
        await assertRate(req.user._id);
        const payload = await parsePayload(req.body);
        await appendMessage(convo, req.user._id, payload);
      }
    } else if (productId) {
      const product = await Product.findById(productId);
      if (!product) return res.status(404).json({ message: 'Product not found' });
      const sellerId = product.creator && (product.creator._id || product.creator);
      if (!sellerId) return res.status(400).json({ message: 'Product has no seller' });
      if (String(sellerId) === String(req.user._id)) {
        return res.status(400).json({ message: 'You cannot chat about your own product', code: 'CHAT_SELF' });
      }
      convo = await upsertConversation(
        { buyer: req.user._id, seller: sellerId, product: product._id },
        {
          contextType: 'product',
          productName: product.name,
          productSlug: product.slug,
          productCover: product.coverUrl || '',
        },
      );
      const hasContent = String(req.body?.body || '').trim() || String(req.body?.imageUrl || '').trim();
      if (hasContent) {
        await assertRate(req.user._id);
        const payload = await parsePayload(req.body);
        await appendMessage(convo, req.user._id, payload);
      }
    } else {
      return res.status(400).json({ message: 'productId, jobId/jobSlug, or talentSlug required' });
    }

    if (!convo) return res.status(500).json({ message: 'Could not open conversation' });

    const full = await Conversation.findById(convo._id)
      .populate('buyer', 'name email')
      .populate('seller', 'name email')
      .lean({ virtuals: true });
    res.status(201).json(mapConversation(full, req.user._id));
  } catch (err) {
    next(err);
  }
});

router.get('/conversations/:id', authenticate, async (req, res, next) => {
  try {
    const convo = await Conversation.findById(req.params.id)
      .populate('buyer', 'name email')
      .populate('seller', 'name email');
    if (!convo) return res.status(404).json({ message: 'Conversation not found' });
    assertMember(convo, req.user._id);
    res.json(mapConversation(convo, req.user._id));
  } catch (err) {
    next(err);
  }
});

router.get('/conversations/:id/messages', authenticate, async (req, res, next) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ message: 'Conversation not found' });
    const { isBuyer } = assertMember(convo, req.user._id);
    const items = await ChatMessage.find({ conversation: convo._id }).sort({ createdAt: 1 }).limit(500).lean();
    if (isBuyer) convo.buyerUnread = 0;
    else convo.sellerUnread = 0;
    await convo.save();
    res.json(items.map(mapMessage));
  } catch (err) {
    next(err);
  }
});

router.post('/conversations/:id/messages', authenticate, async (req, res, next) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ message: 'Conversation not found' });
    assertMember(convo, req.user._id);
    await assertRate(req.user._id);
    const payload = await parsePayload(req.body);
    const msg = await appendMessage(convo, req.user._id, payload);
    res.status(201).json(mapMessage(msg));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
