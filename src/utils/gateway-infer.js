const crypto = require('crypto');
const Product = require('../models/Product');
const UsageEvent = require('../models/UsageEvent');
const UsageStat = require('../models/UsageStat');
const { placeHold, releaseHold } = require('./wallet');
const { preflight } = require('./usage-preflight');
const { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } = require('./idempotency');
const { chargeUsage } = require('../finance/charge-usage');
const { resolveProviderForProduct, computeUsageCost } = require('./provider-resolve');
const { inferWithFallback, fetchJobStatus } = require('./denglish-client');
const { getRunpodPublicEndpoint } = require('../data/runpod-public-endpoints');
const { catalogProductSlug, canonicalProductSlug, catalogModelSlug } = require('./product-slug');
const { rehostMediaDeep, requestOrigin } = require('./media-rehost');
const { publicProvider } = require('./white-label');

function catalogInput(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.input && typeof body.input === 'object' && !Array.isArray(body.input)) {
    return body.input;
  }
  const skip = new Set(['model', 'provider', 'action', 'stream']);
  const rest = {};
  for (const [k, v] of Object.entries(body)) {
    if (!skip.has(k)) rest[k] = v;
  }
  return rest;
}

async function findCatalogProduct(identifier) {
  const raw = decodeURIComponent(String(identifier || '')).trim();
  if (!raw) return null;
  const key = catalogModelSlug(raw.toLowerCase());
  const ep = getRunpodPublicEndpoint(key) || getRunpodPublicEndpoint(raw);
  const slugs = [canonicalProductSlug(raw), raw.toLowerCase(), key, catalogProductSlug(key)];
  if (ep) slugs.push(ep.slug, catalogProductSlug(ep.slug));
  return Product.findOne({ slug: { $in: [...new Set(slugs)] }, published: { $ne: false } });
}

function assertKeyOwnsProduct(req, product) {
  if (req.marketplaceKey && String(req.marketplaceKey.product) !== String(product._id)) {
    const err = new Error('API key cannot access this product');
    err.status = 403;
    err.body = { code: 'FORBIDDEN' };
    throw err;
  }
}

async function meterAndInfer(req, product, input, action = 'runsync') {
  const resolved = resolveProviderForProduct(product);
  // The listing decides the upstream: a buyer-supplied `provider` is never honoured.
  const provider = resolved.provider;
  const model = resolved.model || product.runtime?.baseModel || product.slug;
  const endpointId = resolved.endpointId;
  const buyerId = req.user._id;
  const rawKey = req.headers['idempotency-key'] || req.body?.id;

  // Keys are scoped per buyer and claimed before the upstream call, so concurrent retries
  // can't both run (and bill) and one buyer's key never replays another buyer's result.
  const idem = await claimIdempotencyKey(buyerId, 'gateway', rawKey);
  if (idem.state === 'replay') {
    const stored = idem.claim.response || {};
    return {
      replay: true,
      event: { _id: idem.claim.usageEvent, id: String(idem.claim.usageEvent || '') },
      ai: stored.ai || { ok: true, data: { replay: true } },
      provider,
      model,
      charged: 0,
    };
  }
  let claim = idem.claim;
  const scopedKey = claim ? `${buyerId}:${claim.key}` : null;
  const sellerId = product.creator;
  const selfUse = String(buyerId) === String(sellerId);
  let hold = null;

  try {
    const quote = await preflight({ provider, endpointId, model, input });
    const estimatedCost = computeUsageCost(product, quote.usage, input, {
      upstream: quote.upstreamCost,
      cost: quote.providerCost,
    });
    if (estimatedCost > 0 && !selfUse) {
      try {
        hold = await placeHold(buyerId, estimatedCost, {
          note: `Gateway (reserved): ${product.name}`,
          meta: { channel: 'gateway', productId: String(product._id) },
        });
      } catch (err) {
        if (err.status === 402) err.body = { estimatedCost, ...(err.body || {}) };
        throw err;
      }
    }

    const ai = await inferWithFallback({
      provider,
      model,
      endpointId,
      input,
      action,
      buyerId: String(buyerId),
      idempotencyKey: scopedKey,
    });
    const usage = ai.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, unit: 'tokens' };
    const sandbox = Boolean(ai.raw?.sandbox || ai.data?.sandbox);
    if (sandbox) usage.sandbox = true;
    const aiData = ai.data || {};
    // Async `run` submissions have no cost yet: bill the pre-flight quote for the job.
    const upstream =
      Number(aiData.upstream_cost) || (Number(aiData.cost) ? 0 : Number(quote.upstreamCost) || 0);
    const cost = sandbox
      ? 0
      : computeUsageCost(product, usage, input, { upstream, cost: Number(aiData.cost) || 0 });
    let charged = 0;
    let sellerNet = 0;
    let platformFee = 0;
    let shortfall = 0;

    if (cost > 0 && !selfUse) {
      const billed = await chargeUsage({
        buyerId,
        sellerId,
        product,
        cost,
        holdId: hold?._id || null,
        funds: 'cap',
        note: `Gateway: ${product.name}`,
      });
      hold = null;
      platformFee = billed.platformFee;
      sellerNet = billed.sellerNet;
      charged = billed.charged;
      shortfall = billed.shortfall || 0;
    } else if (hold) {
      await releaseHold(hold);
      hold = null;
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
      rawUsage: shortfall > 0 ? { ...usage, shortfall } : usage,
      source: 'gateway',
      usageType: 'API_REQUEST',
      idempotencyKey: scopedKey ? `gw_${scopedKey}` : `gw_${crypto.randomBytes(8).toString('hex')}`,
    });

    const day = new Date().toISOString().slice(0, 10);
    await UsageStat.updateOne(
      { creator: sellerId, date: day },
      { $inc: { tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0), requests: 1, revenue: sellerNet } },
      { upsert: true }
    ).catch(() => {});

    await completeIdempotencyKey(
      claim,
      { ai: { ok: ai.ok, data: ai.data, usage: ai.usage, raw: ai.raw, latency_ms: ai.latency_ms, model: ai.model } },
      event._id
    );
    claim = null;
    return { replay: false, event, ai, provider, model, charged };
  } finally {
    if (hold) await releaseHold(hold);
    if (claim) await releaseIdempotencyKey(claim);
  }
}

function shapeRunpodResponse(out, action = 'runsync') {
  const ai = out.ai || {};
  const data = ai.data && typeof ai.data === 'object' ? ai.data : {};
  const raw = ai.raw && typeof ai.raw === 'object' ? ai.raw : {};
  const status =
    data.status ||
    raw.status ||
    (action === 'run' ? 'IN_QUEUE' : 'COMPLETED');
  return {
    id: data.id || raw.id || raw.jobId || (out.event && String(out.event._id)) || null,
    status,
    output: data.output || data,
    usage: ai.usage,
    delayTime: raw.delayTime,
    executionTime: raw.executionTime || ai.latency_ms,
    marketplace: { cost: out.charged, provider: publicProvider(out.provider), model: out.model },
  };
}

async function runCatalogModel(req, identifier, action) {
  const product = await findCatalogProduct(identifier);
  if (!product) {
    const err = new Error('Unknown model');
    err.status = 404;
    err.body = { code: 'MODEL_NOT_FOUND', model: identifier };
    throw err;
  }
  assertKeyOwnsProduct(req, product);
  const out = await meterAndInfer(req, product, catalogInput(req.body), action);
  const shaped = shapeRunpodResponse(out, action);
  shaped.output = await rehostMediaDeep(shaped.output, { baseUrl: requestOrigin(req) });
  return shaped;
}

async function pollCatalogJob(req, identifier, jobId) {
  const product = await findCatalogProduct(identifier);
  if (!product) {
    const err = new Error('Unknown model');
    err.status = 404;
    err.body = { code: 'MODEL_NOT_FOUND', model: identifier };
    throw err;
  }
  assertKeyOwnsProduct(req, product);
  const resolved = resolveProviderForProduct(product);
  const result = await fetchJobStatus(resolved.endpointId || resolved.model || identifier, jobId);
  const data = result.data && typeof result.data === 'object' ? result.data : result;
  const raw = result.raw && typeof result.raw === 'object' ? result.raw : {};
  return {
    id: jobId,
    status: data.status || raw.status || result.status || 'UNKNOWN',
    output: await rehostMediaDeep(data.output || data, { baseUrl: requestOrigin(req) }),
    usage: result.usage,
  };
}

module.exports = {
  catalogInput,
  findCatalogProduct,
  meterAndInfer,
  shapeRunpodResponse,
  runCatalogModel,
  pollCatalogJob,
};
