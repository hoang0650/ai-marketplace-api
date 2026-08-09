const express = require('express');
const Product = require('../models/Product');
const UsageEvent = require('../models/UsageEvent');
const WalletTx = require('../models/WalletTx');
const UsageStat = require('../models/UsageStat');
const { authenticate } = require('../middleware/auth');
const { PLATFORM_FEE_RATE } = require('../utils/platform');
const { getBalance } = require('../utils/wallet');
const { resolveProviderForProduct, computeUsageCost } = require('../utils/provider-resolve');
const { agentTurnWithFallback } = require('../utils/denglish-client');

const router = express.Router();

/**
 * POST /api/agents/chat
 * Body: { productSlug | productId, message, sessionId? }
 * Auth JWT — wallet + UsageEvent; persistent memory via denglish-api /v1/agent/turn
 */
router.post('/chat', authenticate, async (req, res, next) => {
  try {
    const { productSlug, productId, message, sessionId } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: 'message is required' });
    }

    let product = null;
    if (productId) product = await Product.findById(productId);
    if (!product && productSlug) {
      product = await Product.findOne({ slug: String(productSlug).toLowerCase() });
    }
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const resolved = resolveProviderForProduct(product);
    // Hire agents default to serverless worker (memory-aware); keep overrides from catalog.
    const provider =
      product.category === 'hire-agent' && !['featherless', 'vercel_gateway'].includes(resolved.provider)
        ? 'runpod_serverless'
        : resolved.provider || 'runpod_serverless';

    const roughTokens = Math.max(1, Math.ceil(String(message).length / 4) + 64);
    const estimatedCost = computeUsageCost(
      product,
      { unit: 'tokens', total_tokens: roughTokens, quantity: roughTokens },
      {}
    );
    if (estimatedCost > 0) {
      const balance = await getBalance(req.user._id);
      if (balance < 0.001 && estimatedCost > 0) {
        return res.status(402).json({
          message: `Insufficient wallet balance (est. $${estimatedCost.toFixed(4)}). Please top up.`,
          estimatedCost,
          balance,
        });
      }
    }

    const started = Date.now();
    const ai = await agentTurnWithFallback({
      userId: req.user._id.toString(),
      agentId: product.slug,
      message: String(message).trim(),
      sessionId: sessionId || undefined,
      provider,
      model: resolved.model || product.runtime?.baseModel || 'denglish-lora',
      endpointId: resolved.endpointId || '',
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
    const cost = computeUsageCost(product, usage, {});

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
        note: `Agent chat: ${product.name}`,
      });
      await WalletTx.create({
        user: sellerId,
        type: 'credit',
        amount: sellerNet,
        currency: 'USD',
        note: `Agent chat revenue: ${product.name}`,
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
      provider: ai.provider || provider,
      unit: usage.unit || 'tokens',
      quantity: Number(usage.quantity) || inputTokens + outputTokens,
      rawUsage: usage,
      source: 'api',
    });

    const day = new Date().toISOString().slice(0, 10);
    await UsageStat.updateOne(
      { creator: sellerId, date: day },
      { $inc: { tokens: inputTokens + outputTokens, requests: 1, revenue: sellerNet } },
      { upsert: true }
    ).catch(() => {});

    res.json({
      ok: true,
      id: event._id.toString(),
      reply: ai.reply || '',
      sessionId: ai.session_id,
      usage,
      cost: charged,
      provider: ai.provider || provider,
      latencyMs: ai.latency_ms || latencyMs,
      memoryApplied: Boolean(ai.memory_applied),
      memoryRecalled: Number(ai.memory_recalled) || 0,
      memoryWritten: Number(ai.memory_written) || 0,
      sandbox: Boolean(ai.sandbox),
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