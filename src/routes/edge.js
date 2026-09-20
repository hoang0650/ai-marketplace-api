const express = require('express');
const Product = require('../models/Product');
const UsageEvent = require('../models/UsageEvent');
const UsageStat = require('../models/UsageStat');
const { authenticate } = require('../middleware/auth');
const { requireAvailableFunds } = require('../utils/wallet');
const { chargeUsage } = require('../finance/charge-usage');
const { resolveProviderForProduct, computeUsageCost } = require('../utils/provider-resolve');
const { inferWithFallback } = require('../utils/denglish-client');

const router = express.Router();

router.post('/infer/:slug', authenticate, async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    const product = await Product.findOne({ slug });
    if (!product) return res.status(404).json({ message: 'Product not found', code: 'SERVER_NOT_FOUND' });

    const input =
      req.body?.input && typeof req.body.input === 'object'
        ? req.body.input
        : {
            messages: req.body?.messages,
            prompt: req.body?.prompt,
            max_tokens: req.body?.max_tokens,
            temperature: req.body?.temperature,
          };

    const resolved = resolveProviderForProduct(product);
    const provider = req.body?.provider || resolved.provider;
    const model = req.body?.model || resolved.model;
    const endpointId = req.body?.endpointId || resolved.endpointId;

    const ai = await inferWithFallback({
      provider,
      model,
      endpointId,
      input,
      action: req.body?.action || 'runsync',
      buyerId: String(req.user._id),
      idempotencyKey: String(req.headers['idempotency-key'] || req.body?.id || '').slice(0, 120) || undefined,
    });

    const usage = ai.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, unit: 'tokens' };
    const providerCost = Number(ai.data?.cost) || 0;
    const cost = computeUsageCost(product, usage, input, providerCost);
    const buyerId = req.user._id;
    const sellerId = product.creator;
    const selfUse = String(buyerId) === String(sellerId);
    let charged = 0;
    let sellerNet = 0;
    let platformFee = 0;

    if (cost > 0 && !selfUse) {
      try {
        await requireAvailableFunds(buyerId, cost);
      } catch (err) {
        if (err.status === 402) {
          return res.status(402).json({ message: err.message, cost, ...(err.body || {}) });
        }
        throw err;
      }
      const billed = await chargeUsage({
        buyerId,
        sellerId,
        product,
        cost,
        note: `API: ${product.name}`,
      });
      platformFee = billed.platformFee;
      sellerNet = billed.sellerNet;
      charged = billed.charged;
    }

    await UsageEvent.create({
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
      quantity: Number(usage.quantity) || 0,
      rawUsage: usage,
      source: 'api',
    });

    const day = new Date().toISOString().slice(0, 10);
    await UsageStat.updateOne(
      { creator: sellerId, date: day },
      { $inc: { tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0), requests: 1, revenue: sellerNet } },
      { upsert: true }
    ).catch(() => {});

    res.json({
      ok: !!ai.ok,
      provider,
      model,
      productSlug: slug,
      data: ai.data,
      usage,
      cost: charged,
      sandbox: !!ai.raw?.sandbox || !!ai.sandbox,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
