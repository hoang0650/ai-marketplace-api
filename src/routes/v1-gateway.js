const express = require('express');
const Product = require('../models/Product');
const { authenticate } = require('../middleware/auth');
const { authenticateMarketplaceKey } = require('../middleware/marketplace-key');
const { meterAndInfer } = require('../utils/gateway-infer');
const { productSlugQuery } = require('../utils/product-slug');
const { rehostMediaDeep, requestOrigin } = require('../utils/media-rehost');
const { publicProvider, publicPayload } = require('../utils/white-label');

const router = express.Router();

function authStack(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token.startsWith('mk_live_')) return authenticateMarketplaceKey(req, res, next);
  return authenticate(req, res, next);
}

async function resolveProduct(req) {
  if (req.marketplaceKey) {
    return Product.findById(req.marketplaceKey.product);
  }
  const slug = String(req.body?.model || req.query?.model || '').toLowerCase();
  if (!slug) return null;
  return Product.findOne(productSlugQuery(slug));
}

function sendGatewayError(res, next, e) {
  if (e.status === 402) return res.status(402).json({ message: e.message, ...e.body });
  if (e.status === 403) return res.status(403).json({ message: e.message, ...e.body });
  if (e.status === 404) return res.status(404).json({ message: e.message, ...e.body });
  if (e.status === 409 || (e.status === 503 && e.code === 'WALLET_BUSY')) {
    return res.status(e.status).json({ message: e.message, code: e.code, ...e.body });
  }
  return next(e);
}

router.get('/models', authStack, async (req, res, next) => {
  try {
    const filter = req.marketplaceKey
      ? { _id: req.marketplaceKey.product }
      : { published: { $ne: false } };
    const rows = await Product.find(filter).sort({ featured: -1 }).limit(100).lean();
    res.json({
      object: 'list',
      data: rows.map((p) => ({
        id: p.slug,
        object: 'model',
        owned_by: p.creatorSlug,
        productType: p.productType || 'MODEL',
        provider: p.provider || undefined,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/chat/completions', authStack, async (req, res, next) => {
  try {
    const product = await resolveProduct(req);
    if (!product) return res.status(400).json({ message: 'model (product slug) required' });
    if (req.marketplaceKey && String(req.marketplaceKey.product) !== String(product._id)) {
      return res.status(403).json({ message: 'API key cannot access this product', code: 'FORBIDDEN' });
    }
    const input = {
      messages: req.body?.messages,
      prompt: req.body?.prompt,
      max_tokens: req.body?.max_tokens,
      temperature: req.body?.temperature,
    };
    const out = await meterAndInfer(req, product, input);
    const text =
      out.ai?.data?.text ||
      out.ai?.data?.choices?.[0]?.message?.content ||
      '';
    res.json({
      id: `chatcmpl_${out.event.id}`,
      object: 'chat.completion',
      model: product.slug,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: out.ai?.usage,
      marketplace: { cost: out.charged, provider: publicProvider(out.provider) },
    });
  } catch (e) {
    sendGatewayError(res, next, e);
  }
});

router.post('/embeddings', authStack, async (req, res, next) => {
  try {
    const product = await resolveProduct(req);
    if (!product) return res.status(400).json({ message: 'model required' });
    const input = { prompt: req.body?.input || req.body?.prompt, action: 'embeddings' };
    const out = await meterAndInfer(req, product, input);
    res.json({ object: 'list', data: publicPayload(out.ai?.data) || [], model: product.slug, usage: out.ai?.usage });
  } catch (e) {
    sendGatewayError(res, next, e);
  }
});

router.post('/images', authStack, async (req, res, next) => {
  try {
    const product = await resolveProduct(req);
    if (!product) return res.status(400).json({ message: 'model required' });
    const input = { prompt: req.body?.prompt, image: req.body?.image };
    const out = await meterAndInfer(req, product, input);
    const data = await rehostMediaDeep(out.ai?.data || out.ai, { baseUrl: requestOrigin(req) });
    res.json({ data, model: product.slug, usage: out.ai?.usage });
  } catch (e) {
    sendGatewayError(res, next, e);
  }
});

router.post('/audio', authStack, async (req, res, next) => {
  try {
    const product = await resolveProduct(req);
    if (!product) return res.status(400).json({ message: 'model required' });
    const input = { prompt: req.body?.input || req.body?.prompt };
    const out = await meterAndInfer(req, product, input);
    const data = await rehostMediaDeep(out.ai?.data || out.ai, { baseUrl: requestOrigin(req) });
    res.json({ data, model: product.slug, usage: out.ai?.usage });
  } catch (e) {
    sendGatewayError(res, next, e);
  }
});

module.exports = router;
module.exports.authStack = authStack;
module.exports.sendGatewayError = sendGatewayError;
