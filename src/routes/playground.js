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

/**
 * POST /api/playground/run
 * Body: { productSlug | productId, input, provider?, model?, endpointId?, action? }
 * Auth: JWT — charges wallet + records UsageEvent, proxies AI via denglish-api.
 */
router.post('/run', authenticate, async (req, res, next) => {
  try {
    const {
      productSlug,
      productId,
      input,
      provider: providerOverride,
      model: modelOverride,
      endpointId: endpointOverride,
      action = 'runsync',
    } = req.body || {};

    if (!input || typeof input !== 'object') {
      return res.status(400).json({ message: 'input object is required' });
    }

    let product = null;
    if (productId) product = await Product.findById(productId);
    if (!product && productSlug) product = await Product.findOne({ slug: String(productSlug).toLowerCase() });
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const resolved = resolveProviderForProduct(product);
    const provider = providerOverride || resolved.provider;
    const endpointId = endpointOverride || resolved.endpointId;
    const model = modelOverride || resolved.model;

    // Preflight cost estimate (tokens unknown → use rough prompt length for text)
    const roughTokens = Math.max(1, Math.ceil(JSON.stringify(input).length / 4));
    const estimateUsage = {
      unit: input.duration ? 'seconds' : input.image && !input.prompt ? 'images' : 'tokens',
      quantity: input.duration || (input.image ? 1 : roughTokens),
      total_tokens: roughTokens,
    };
    const estimatedCost = computeUsageCost(product, estimateUsage, input);
    if (estimatedCost > 0) {
      const balance = await getBalance(req.user._id);
      // Allow run if balance covers estimate; final charge may differ slightly
      if (balance < estimatedCost * 0.5 && balance < 0.001) {
        return res.status(402).json({
          message: `Insufficient wallet balance (est. $${estimatedCost.toFixed(4)}). Please top up.`,
          estimatedCost,
          balance,
        });
      }
    }

    const started = Date.now();
    const ai = await inferWithFallback({
      provider,
      model,
      endpointId,
      input,
      action,
    });
    const latencyMs = Date.now() - started;

    const usage = ai.usage || {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      unit: 'tokens',
      quantity: 0,
    };
    const inputTokens = Number(usage.input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;
    const cost = computeUsageCost(product, usage, input);

    const buyerId = req.user._id;
    const sellerId = product.creator;
    const selfUse = String(buyerId) === String(sellerId);

    let charged = 0;
    let sellerNet = 0;
    let platformFee = 0;

    if (cost > 0 && !selfUse) {
      const balance = await getBalance(buyerId);
      if (balance < cost) {
        return res.status(402).json({
          message: `Insufficient wallet balance (need $${cost.toFixed(4)}, have $${balance.toFixed(4)}).`,
          cost,
          balance,
          usage,
        });
      }
      platformFee = Math.round(cost * PLATFORM_FEE_RATE * 1e6) / 1e6;
      sellerNet = Math.round((cost - platformFee) * 1e6) / 1e6;
      charged = cost;

      await WalletTx.create({
        user: buyerId,
        type: 'debit',
        amount: cost,
        currency: 'USD',
        note: `Playground: ${product.name}`,
      });
      await WalletTx.create({
        user: sellerId,
        type: 'credit',
        amount: sellerNet,
        currency: 'USD',
        note: `Playground revenue: ${product.name} (net after fee)`,
      });
    }

    const event = await UsageEvent.create({
      deployment: null,
      product: product._id,
      buyer: buyerId,
      seller: sellerId,
      inputTokens,
      outputTokens,
      cost: charged,
      platformFee,
      sellerNet,
      provider,
      unit: usage.unit || 'tokens',
      quantity: Number(usage.quantity) || 0,
      rawUsage: usage,
      source: 'playground',
    });

    const day = new Date().toISOString().slice(0, 10);
    await UsageStat.updateOne(
      { creator: sellerId, date: day },
      {
        $inc: {
          tokens: inputTokens + outputTokens,
          requests: 1,
          revenue: sellerNet,
        },
      },
      { upsert: true }
    ).catch(() => {});

    const data = ai.data || {};
    const output =
      typeof data === 'object'
        ? {
            ...data,
            cost: charged,
            usage: {
              input: inputTokens,
              output: outputTokens,
              unit: usage.unit,
              quantity: usage.quantity,
            },
          }
        : { text: String(data), cost: charged };

    res.json({
      ok: true,
      id: event._id.toString(),
      status: 'COMPLETED',
      provider,
      model,
      endpointId,
      delayTime: 0,
      executionTime: ai.latency_ms || latencyMs,
      output,
      usage,
      cost: charged,
      platformFee,
      sellerNet,
      currency: 'USD',
      sandbox: Boolean(ai.raw?.sandbox),
    });
  } catch (err) {
    if (err.code === 'DENGLISH_NOT_CONFIGURED') {
      return res.status(503).json({ message: err.message });
    }
    if (err.name === 'AbortError') {
      return res.status(504).json({ message: 'denglish-api timeout' });
    }
    if (err.status) {
      return res.status(502).json({ message: err.message, detail: err.body });
    }
    next(err);
  }
});

module.exports = router;
