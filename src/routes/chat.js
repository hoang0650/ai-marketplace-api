const express = require('express');
const Product = require('../models/Product');
const Conversation = require('../models/Conversation');
const ChatMessage = require('../models/ChatMessage');
const Notification = require('../models/Notification');
const { authenticate } = require('../middleware/auth');
const { containsBlockedLink, isAllowedChatImageUrl } = require('../utils/chat-security');

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
  return {
    id: String(o._id || o.id),
    productId: String(o.product?._id || o.product || ''),
    productName: o.productName || o.product?.name || '',
    productSlug: o.productSlug || o.product?.slug || '',
    productCover: o.productCover || o.product?.coverUrl || '',
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
  await Notification.create({
    user: recipient,
    title: isBuyer ? 'Tin nhắn từ người mua' : 'Tin nhắn từ người bán',
    body: `${convo.productName || 'Sản phẩm'}: ${preview}`.slice(0, 280),
    href: isBuyer ? `/sell/messages/${convo._id}` : `/messages/${convo._id}`,
  }).catch(() => {});
  return msg;
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
    if (!productId) return res.status(400).json({ message: 'productId required' });
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const sellerId = product.creator && (product.creator._id || product.creator);
    if (!sellerId) return res.status(400).json({ message: 'Product has no seller' });
    if (String(sellerId) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot chat about your own product', code: 'CHAT_SELF' });
    }

    const query = { buyer: req.user._id, seller: sellerId, product: product._id };
    let convo = await Conversation.findOne(query);
    if (!convo) {
      try {
        convo = await Conversation.create({
          ...query,
          productName: product.name,
          productSlug: product.slug,
          productCover: product.coverUrl || '',
          lastMessageAt: new Date(),
        });
      } catch (err) {
        if (err.code !== 11000) throw err;
        convo = await Conversation.findOne(query);
      }
    }
    if (!convo) return res.status(500).json({ message: 'Could not open conversation' });

    const hasContent = String(req.body?.body || '').trim() || String(req.body?.imageUrl || '').trim();
    if (hasContent) {
      await assertRate(req.user._id);
      const payload = await parsePayload(req.body);
      await appendMessage(convo, req.user._id, payload);
    }

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
