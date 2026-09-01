const crypto = require('crypto');
const express = require('express');
const Product = require('../models/Product');
const UsageEvent = require('../models/UsageEvent');
const WalletTx = require('../models/WalletTx');
const UsageStat = require('../models/UsageStat');
const { authenticate } = require('../middleware/auth');
const { authenticateMarketplaceKey } = require('../middleware/marketplace-key');
const { PLATFORM_FEE_RATE } = require('../utils/platform');
const { getBalance } = require('../utils/wallet');
const { resolveProviderForProduct, computeUsageCost } = require('../utils/provider-resolve');
const { inferWithFallback } = require('../utils/denglish-client');

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
  return Product.findOne({ slug });
}

async function meterAndInfer(req, product, input) {
  const resolved = resolveProviderForProduct(product);
  const provider = req.body?.provider || resolved.provider;
  const model = resolved.model || product.runtime?.baseModel || product.slug;
  const endpointId = resolved.endpointId;
  const idempotencyKey = String(req.headers['idempotency-key'] || req.body?.id || '').slice(0, 120) || null;

  if (idempotencyKey) {
    const dup = await UsageEvent.findOne({ idempotencyKey });
    if (dup) {
      return { replay: true, event: dup, ai: { ok: true, data: { replay: true }, usage: dup.rawUsage } };
    }
  }

  const ai = await inferWithFallback({
    provider,
    model,
    endpointId,
    input,
    action: 'runsync',
  });
  const usage = ai.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, unit: 'tokens' };
  const cost = computeUsageCost(product, usage, input, Number(ai.data?.cost) || 0);
  const buyerId = req.user._id;
  const sellerId = product.creator;
  const selfUse = String(buyerId) === String(sellerId);
  let charged = 0;
  let sellerNet = 0;
  let platformFee = 0;

  if (cost > 0 && !selfUse) {
    const balance = await getBalance(buyerId);
    if (balance < cost) {
      const err = new Error('Insufficient wallet balance');
      err.status = 402;
      err.body = { cost, balance };
      throw err;
    }
    platformFee = Math.round(cost * PLATFORM_FEE_RATE * 1e6) / 1e6;
    sellerNet = Math.round((cost - platformFee) * 1e6) / 1e6;
    charged = cost;
    await WalletTx.create({
      user: buyerId,
      type: 'debit',
      amount: cost,
      currency: 'USD',
      note: `Gateway: ${product.name}`,
    });
    await WalletTx.create({
      user: sellerId,
      type: 'credit',
      amount: sellerNet,
      currency: 'USD',
      note: `Gateway revenue: ${product.name}`,
    });
  }

  const event = await UsageEvent.create({
    deployment: null,
    product: product._id,
    buyer: buyerId,
    seller: sellerId,
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    cost: charged,
    platformFee,
    sellerNet,
    provider,
    unit: usage.unit || 'tokens',
    quantity: Number(usage.quantity) || Number(usage.total_tokens) || 0,
    rawUsage: usage,
    source: 'gateway',
    usageType: 'API_REQUEST',
    idempotencyKey: idempotencyKey || `gw_${crypto.randomBytes(8).toString('hex')}`,
  });

  const day = new Date().toISOString().slice(0, 10);
  await UsageStat.updateOne(
    { creator: sellerId, date: day },
    { $inc: { tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0), requests: 1, revenue: sellerNet } },
    { upsert: true }
  ).catch(() => {});

  return { replay: false, event, ai, provider, model, charged };
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
      marketplace: { cost: out.charged, provider: out.provider },
    });
  } catch (e) {
    if (e.status === 402) return res.status(402).json({ message: e.message, ...e.body });
    next(e);
  }
});

router.post('/embeddings', authStack, async (req, res, next) => {
  try {
    const product = await resolveProduct(req);
    if (!product) return res.status(400).json({ message: 'model required' });
    const input = { prompt: req.body?.input || req.body?.prompt, action: 'embeddings' };
    const out = await meterAndInfer(req, product, input);
    res.json({ object: 'list', data: out.ai?.data || [], model: product.slug, usage: out.ai?.usage });
  } catch (e) {
    if (e.status === 402) return res.status(402).json({ message: e.message, ...e.body });
    next(e);
  }
});

router.post('/images', authStack, async (req, res, next) => {
  try {
    const product = await resolveProduct(req);
    if (!product) return res.status(400).json({ message: 'model required' });
    const input = { prompt: req.body?.prompt, image: req.body?.image };
    const out = await meterAndInfer(req, product, input);
    res.json({ data: out.ai?.data || out.ai, model: product.slug, usage: out.ai?.usage });
  } catch (e) {
    if (e.status === 402) return res.status(402).json({ message: e.message, ...e.body });
    next(e);
  }
});

router.post('/audio', authStack, async (req, res, next) => {
  try {
    const product = await resolveProduct(req);
    if (!product) return res.status(400).json({ message: 'model required' });
    const input = { prompt: req.body?.input || req.body?.prompt };
    const out = await meterAndInfer(req, product, input);
    res.json({ data: out.ai?.data || out.ai, model: product.slug, usage: out.ai?.usage });
  } catch (e) {
    if (e.status === 402) return res.status(402).json({ message: e.message, ...e.body });
    next(e);
  }
});

module.exports = router;
