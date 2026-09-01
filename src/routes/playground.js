const express = require('express');
const Product = require('../models/Product');
const UsageEvent = require('../models/UsageEvent');
const WalletTx = require('../models/WalletTx');
const UsageStat = require('../models/UsageStat');
const { authenticate } = require('../middleware/auth');
const { PLATFORM_FEE_RATE } = require('../utils/platform');
const { getBalance } = require('../utils/wallet');
const { resolveProviderForProduct, computeUsageCost } = require('../utils/provider-resolve');
const { inferWithFallback, quoteInference } = require('../utils/denglish-client');

const router = express.Router();

const MEDIA_FIELDS = ['image_url', 'video_url', 'audio_url'];

/**
 * Ask denglish-api for the exact RunPod payload and the price.
 *
 * `providerCost` is the sell price (RunPod's documented cost plus the configured
 * markup); `upstreamCost` is what RunPod itself charges, kept for reporting.
 * Falls back to a coarse local guess when denglish-api or the catalog can't help.
 */
async function preflight({ provider, endpointId, model, input }) {
  if (provider === 'runpod_public') {
    try {
      const q = await quoteInference({ model: endpointId || model, input });
      return {
        usage: { unit: q.unit, quantity: q.quantity, total_tokens: 0 },
        providerCost: Number(q.estimatedCost) || 0,
        upstreamCost: Number(q.upstreamCost) || 0,
        markup: Number(q.markup) || 0,
        warnings: q.warnings || [],
      };
    } catch {
      /* denglish-api unavailable — fall through to the local guess */
    }
  }
  const roughTokens = Math.max(1, Math.ceil(JSON.stringify(input).length / 4));
  const unit = input.duration ? 'seconds' : input.image && !input.prompt ? 'images' : 'tokens';
  return {
    usage: {
      unit,
      quantity: input.duration || (input.image ? 1 : roughTokens),
      total_tokens: roughTokens,
    },
    providerCost: 0,
    upstreamCost: 0,
    markup: 0,
    warnings: [],
  };
}

/**
 * Flatten the provider payload into the shape the playground UI renders:
 * one media URL (or text) plus the metering the buyer was charged for.
 */
function buildOutput(data, { kind, charged, providerCost, upstreamCost, usage }) {
  if (!data || typeof data !== 'object') {
    return { kind: kind || 'text', text: String(data ?? ''), cost: charged };
  }

  const output = {
    kind: data.kind || kind || (MEDIA_FIELDS.find((f) => data[f]) || 'text').replace('_url', ''),
  };
  for (const field of MEDIA_FIELDS) {
    if (data[field]) output[field] = data[field];
  }
  if (Array.isArray(data.images) && data.images.length) output.images = data.images;
  if (data.text) output.text = data.text;
  if (data.seed !== undefined) output.seed = data.seed;
  if (data.job_id) output.jobId = data.job_id;
  if (data.raw_output !== undefined) output.rawOutput = data.raw_output;

  output.cost = charged;
  output.providerCost = providerCost;
  output.upstreamCost = upstreamCost;
  output.usage = {
    input: Number(usage.input_tokens) || 0,
    output: Number(usage.output_tokens) || 0,
    unit: usage.unit,
    quantity: usage.quantity,
  };
  return output;
}

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

    const quote = await preflight({ provider, endpointId, model, input });
    const estimatedCost = computeUsageCost(product, quote.usage, input, quote.providerCost);
    if (estimatedCost > 0) {
      const balance = await getBalance(req.user._id);
      // Allow run if balance covers estimate; final charge may differ slightly
      if (balance < estimatedCost * 0.5 && balance < 0.001) {
        return res.status(402).json({
          message: `Insufficient wallet balance (est. $${estimatedCost.toFixed(4)}). Please top up.`,
          estimatedCost,
          balance,
          warnings: quote.warnings.length ? quote.warnings : undefined,
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
    const data = ai.data && typeof ai.data === 'object' ? ai.data : {};
    // denglish-api reports RunPod's own price as upstream_cost and the sell price
    // (upstream + markup) as cost, computed from output.cost when RunPod returns
    // one, otherwise from the formula on the model's docs page.
    const providerCost = Number(data.cost) || quote.providerCost || 0;
    const upstreamCost = Number(data.upstream_cost) || quote.upstreamCost || 0;
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

    const output = buildOutput(data, {
      kind: ai.raw?.kind,
      charged,
      providerCost,
      upstreamCost,
      usage,
    });

    res.json({
      ok: true,
      id: event._id.toString(),
      status: data.status || 'COMPLETED',
      provider,
      model: ai.model || model,
      endpointId: ai.raw?.endpointId || endpointId,
      delayTime: Number(ai.raw?.delayTime) || 0,
      executionTime: Number(ai.raw?.executionTime) || ai.latency_ms || latencyMs,
      output,
      usage,
      cost: charged,
      providerCost,
      upstreamCost,
      markup: Number(data.markup) || quote.markup || 0,
      platformFee,
      sellerNet,
      currency: 'USD',
      warnings: ai.raw?.warnings?.length ? ai.raw.warnings : undefined,
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
