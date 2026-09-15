const crypto = require('crypto');
const Product = require('../models/Product');
const UsageEvent = require('../models/UsageEvent');
const UsageStat = require('../models/UsageStat');
const { getBalance } = require('./wallet');
const { chargeUsage } = require('../finance/charge-usage');
const { resolveProviderForProduct, computeUsageCost } = require('./provider-resolve');
const { inferWithFallback, fetchJobStatus } = require('./denglish-client');
const { getRunpodPublicEndpoint } = require('../data/runpod-public-endpoints');

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
  const key = raw.toLowerCase().replace(/^runpod-/, '');
  const ep = getRunpodPublicEndpoint(key) || getRunpodPublicEndpoint(raw);
  const slugs = [raw.toLowerCase(), key, `runpod-${key}`];
  if (ep) slugs.push(ep.slug, `runpod-${ep.slug}`);
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
  const provider = req.body?.provider || resolved.provider;
  const model = resolved.model || product.runtime?.baseModel || product.slug;
  const endpointId = resolved.endpointId;
  const idempotencyKey = String(req.headers['idempotency-key'] || req.body?.id || '').slice(0, 120) || null;

  if (idempotencyKey) {
    const dup = await UsageEvent.findOne({ idempotencyKey });
    if (dup) {
      return { replay: true, event: dup, ai: { ok: true, data: { replay: true }, usage: dup.rawUsage }, provider, model, charged: 0 };
    }
  }

  const ai = await inferWithFallback({
    provider,
    model,
    endpointId,
    input,
    action,
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
    const billed = await chargeUsage({
      buyerId,
      sellerId,
      product,
      cost,
      note: `Gateway: ${product.name}`,
    });
    platformFee = billed.platformFee;
    sellerNet = billed.sellerNet;
    charged = billed.charged;
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
    marketplace: { cost: out.charged, provider: out.provider, model: out.model },
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
  return shapeRunpodResponse(out, action);
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
    output: data.output || data,
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
