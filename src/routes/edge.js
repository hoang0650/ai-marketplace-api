const express = require('express');
const Product = require('../models/Product');
const UsageEvent = require('../models/UsageEvent');
const WalletTx = require('../models/WalletTx');
const UsageStat = require('../models/UsageStat');
const { authenticate } = require('../middleware/auth');
const { PLATFORM_FEE_RATE } = require('../utils/platform');
const { getBalance } = require('../utils/wallet');
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
      const balance = await getBalance(buyerId);
      if (balance < cost) {
        return res.status(402).json({ message: 'Insufficient wallet balance', cost, balance });
      }
      platformFee = Math.round(cost * PLATFORM_FEE_RATE * 1e6) / 1e6;
      sellerNet = Math.round((cost - platformFee) * 1e6) / 1e6;
      charged = cost;
      await WalletTx.create({
        user: buyerId,
        type: 'debit',
        amount: cost,
        currency: 'USD',
        note: `API: ${product.name}`,
      });
      await WalletTx.create({
        user: sellerId,
        type: 'credit',
        amount: sellerNet,
        currency: 'USD',
        note: `API revenue: ${product.name}`,
      });
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
