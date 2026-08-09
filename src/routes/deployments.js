const express = require('express');
const crypto = require('crypto');
const Deployment = require('../models/Deployment');
const UsageEvent = require('../models/UsageEvent');
const Product = require('../models/Product');
const WalletTx = require('../models/WalletTx');
const UsageStat = require('../models/UsageStat');
const { authenticate, requireRoles } = require('../middleware/auth');
const { PLATFORM_FEE_RATE } = require('../utils/platform');
const { getBalance } = require('../utils/wallet');
const { slugify } = require('../utils/serialize');
const { normalizeRuntime, normalizeRuntimeForStorage, publicRuntime, mergeRuntime } = require('../utils/runtime');
const { deleteCachePattern } = require('../utils/cache');

const router = express.Router();

const MODEL_CATEGORIES = [
  'text-to-text',
  'text-to-video',
  'image-to-video',
  'text-to-image',
  'image-to-image',
  'inference',
  'fine-tune',
];
const AGENT_CATEGORIES = ['hire-agent', 'hire-workflow', 'skill-pack'];

function kindForCategory(category) {
  if (MODEL_CATEGORIES.includes(category)) return 'model';
  if (AGENT_CATEGORIES.includes(category)) return 'agent';
  return null;
}

function estimateTokens(text) {
  const s = String(text || '');
  return s.length === 0 ? 0 : Math.max(1, Math.ceil(s.length / 4));
}

function computeCost(product, totalTokens) {
  if (product.pricing?.model !== 'usage') return 0;
  const rate = Number(product.pricing.usageRate) || 0;
  return Math.round((totalTokens / 1000) * rate * 1e6) / 1e6;
}

function toPublic(dep, { includeSecrets = false } = {}) {
  const runtime = publicRuntime(dep.runtime, {
    includeSecrets,
    maskProviderUrls: true,
    modelId: dep.productSlug || dep.slug,
  });
  return {
    id: dep._id.toString(),
    name: dep.name,
    slug: dep.slug,
    kind: dep.kind,
    status: dep.status,
    visibility: dep.visibility,
    productId: dep.product ? String(dep.product._id || dep.product) : undefined,
    productSlug: dep.productSlug,
    productName: dep.productName,
    ownerName: dep.ownerName || undefined,
    /** Buyer-facing gateway URL (api.aimarkets.vn). */
    endpoint: runtime.publicEndpoint || runtime.serverlessEndpoint || '',
    runtime,
    /** Legacy alias used by older FE — same as runtime without secrets. */
    config: {
      baseModel: runtime.baseModel,
      systemPrompt: runtime.systemPrompt,
      temperature: runtime.temperature,
      maxTokens: runtime.maxTokens,
      tools: runtime.skills,
    },
    ...(includeSecrets ? { apiKey: dep.apiKey } : {}),
    totals: {
      requests: dep.totals?.requests || 0,
      inputTokens: dep.totals?.inputTokens || 0,
      outputTokens: dep.totals?.outputTokens || 0,
      cost: Math.round((dep.totals?.cost || 0) * 100) / 100,
    },
    createdAt: dep.createdAt ? new Date(dep.createdAt).toISOString() : undefined,
    updatedAt: dep.updatedAt ? new Date(dep.updatedAt).toISOString() : undefined,
  };
}

async function findOwnedDeployment(req, res) {
  const dep = await Deployment.findById(req.params.id);
  if (!dep) {
    res.status(404).json({ message: 'Deployment not found' });
    return null;
  }
  if (req.user.role !== 'admin' && String(dep.owner) !== String(req.user._id)) {
    res.status(403).json({ message: 'Forbidden' });
    return null;
  }
  return dep;
}

/**
 * Seller deploys their own product with RunPod / gateway runtime.
 * Only the product creator (or admin) may create a deployment.
 */
router.post('/', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const product = await Product.findById(body.productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    if (
      req.user.role !== 'admin' &&
      String(product.creator) !== String(req.user._id)
    ) {
      return res.status(403).json({ message: 'Only the product seller can deploy this product' });
    }

    const kind = kindForCategory(product.category);
    if (!kind) {
      return res.status(400).json({ message: `Category "${product.category}" is not deployable` });
    }

    const name = String(body.name || product.name).trim().slice(0, 120);
    const slug = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;

    // Start from product.runtime defaults, then apply seller overrides from body.runtime / body.config.
    // Provider hosts are folded into UPSTREAM_* env; public fields stay on api.aimarkets.vn.
    const runtime = normalizeRuntimeForStorage(body.runtime || body.config || {}, {
      defaults: {
        ...product.runtime?.toObject?.() || product.runtime || {},
        baseModel: product.runtime?.baseModel || product.name,
      },
    });

    if (!runtime.serverlessEndpoint && !runtime.publicEndpoint) {
      return res.status(400).json({
        message: 'serverlessEndpoint or publicEndpoint is required',
      });
    }

    const deployment = await Deployment.create({
      owner: req.user._id,
      product: product._id,
      productSlug: product.slug,
      productName: product.name,
      seller: product.creator,
      kind,
      name,
      slug,
      status: 'running',
      visibility: body.visibility === 'public' ? 'public' : 'private',
      runtime,
      apiKey: `pk_${crypto.randomBytes(24).toString('hex')}`,
    });

    // Keep catalog product runtime in sync when seller deploys (source of truth for listing).
    if (body.syncProduct !== false) {
      product.runtime = runtime;
      await product.save();
      deleteCachePattern('products:*').catch(() => {});
    }

    res.status(201).json(toPublic(deployment, { includeSecrets: true }));
  } catch (err) {
    next(err);
  }
});

/** Seller's deployments (secrets included). */
router.get('/mine', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const filter =
      req.user.role === 'admin' && req.query.all === '1'
        ? {}
        : { owner: req.user._id };
    const rows = await Deployment.find(filter).sort({ createdAt: -1 }).lean();
    res.json(rows.map((d) => toPublic({ ...d, _id: d._id }, { includeSecrets: true })));
  } catch (err) {
    next(err);
  }
});

/** Public Agent Browser. */
router.get('/browser', async (_req, res, next) => {
  try {
    const rows = await Deployment.find({ visibility: 'public', status: 'running' })
      .sort({ 'totals.requests': -1, createdAt: -1 })
      .limit(100)
      .populate('owner', 'name creatorSlug')
      .lean();
    res.json(
      rows.map((d) =>
        toPublic({ ...d, _id: d._id, ownerName: d.owner?.name || 'Unknown' })
      )
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Seller updates runtime: RunPod serverless, tokenize, gateway, public endpoint, .env, skills.
 * Optionally syncs back to Product.runtime.
 */
router.patch('/:id', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const dep = await findOwnedDeployment(req, res);
    if (!dep) return;

    const body = req.body || {};
    if (body.name) dep.name = String(body.name).trim().slice(0, 120);
    if (body.status && ['running', 'stopped'].includes(body.status)) dep.status = body.status;
    if (body.visibility && ['private', 'public'].includes(body.visibility)) {
      dep.visibility = body.visibility;
    }

    const runtimePatch = body.runtime || body.config;
    if (runtimePatch && typeof runtimePatch === 'object') {
      const merged = mergeRuntime(dep.runtime?.toObject?.() || dep.runtime, runtimePatch);
      dep.runtime = normalizeRuntimeForStorage(merged, {
        defaults: dep.runtime?.toObject?.() || dep.runtime || {},
      });
      if (!dep.runtime.serverlessEndpoint && !dep.runtime.publicEndpoint) {
        return res.status(400).json({
          message: 'serverlessEndpoint or publicEndpoint is required',
        });
      }
    }

    await dep.save();

    if (body.syncProduct) {
      const product = await Product.findById(dep.product);
      if (product && (req.user.role === 'admin' || String(product.creator) === String(req.user._id))) {
        product.runtime = normalizeRuntimeForStorage(dep.runtime, {
          defaults: product.runtime?.toObject?.() || product.runtime || {},
        });
        await product.save();
        deleteCachePattern('products:*').catch(() => {});
      }
    }

    res.json(toPublic(dep, { includeSecrets: true }));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const dep = await findOwnedDeployment(req, res);
    if (!dep) return;
    await dep.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Metered invoke — buyers (or seller self-test) call through the marketplace.
 * Tokens: client-reported → else estimate. Billing uses product usageRate / 1K tokens.
 */
router.post('/:id/invoke', authenticate, async (req, res, next) => {
  try {
    const dep = await Deployment.findById(req.params.id);
    if (!dep) return res.status(404).json({ message: 'Deployment not found' });
    if (dep.status !== 'running') {
      return res.status(409).json({ message: 'Deployment is not running' });
    }
    if (
      dep.visibility !== 'public' &&
      req.user.role !== 'admin' &&
      String(dep.owner) !== String(req.user._id)
    ) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const body = req.body || {};
    const maxTok = dep.runtime?.maxTokens || 1024;
    const inputTokens = Number.isFinite(Number(body.inputTokens))
      ? Math.max(0, Math.floor(Number(body.inputTokens)))
      : estimateTokens(body.input);
    const outputTokens = Number.isFinite(Number(body.outputTokens))
      ? Math.max(0, Math.floor(Number(body.outputTokens)))
      : Math.min(maxTok, Math.max(estimateTokens(body.input) * 2, 16));
    const totalTokens = inputTokens + outputTokens;
    if (totalTokens > 1_000_000) {
      return res.status(400).json({ message: 'Token count too large for a single invocation' });
    }

    const product = await Product.findById(dep.product).lean();
    if (!product) return res.status(404).json({ message: 'Product behind deployment is gone' });

    const cost = computeCost(product, totalTokens);
    const buyerId = req.user._id;
    const sellerId = dep.seller;
    const selfUse = String(buyerId) === String(sellerId);

    let charged = 0;
    let sellerNet = 0;
    let platformFee = 0;

    if (cost > 0 && !selfUse) {
      const balance = await getBalance(buyerId);
      if (balance < cost) {
        return res.status(402).json({
          message: `Insufficient wallet balance (need ${cost.toFixed(4)}, have ${balance.toFixed(4)}). Please top up.`,
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
        note: `Usage: ${dep.name} (${totalTokens} tokens)`,
      });
      await WalletTx.create({
        user: sellerId,
        type: 'credit',
        amount: sellerNet,
        currency: 'USD',
        note: `Usage revenue: ${dep.name} (${totalTokens} tokens, net after 20% fee)`,
      });
    }

    const event = await UsageEvent.create({
      deployment: dep._id,
      product: dep.product,
      buyer: buyerId,
      seller: sellerId,
      inputTokens,
      outputTokens,
      cost: charged,
      platformFee,
      sellerNet,
      provider: '',
      unit: 'tokens',
      quantity: totalTokens,
      source: 'deployment',
    });

    const day = new Date().toISOString().slice(0, 10);
    await UsageStat.updateOne(
      { creator: sellerId, date: day },
      { $inc: { tokens: totalTokens, requests: 1, revenue: sellerNet } },
      { upsert: true }
    );
    await Deployment.updateOne(
      { _id: dep._id },
      {
        $inc: {
          'totals.requests': 1,
          'totals.inputTokens': inputTokens,
          'totals.outputTokens': outputTokens,
          'totals.cost': charged,
        },
      }
    );

    const rt = publicRuntime(dep.runtime);
    res.status(201).json({
      ok: true,
      eventId: event._id.toString(),
      inputTokens,
      outputTokens,
      totalTokens,
      cost: charged,
      sellerNet,
      platformFee,
      currency: 'USD',
      endpoint: rt.publicEndpoint || rt.serverlessEndpoint || '',
      tokenizeEndpoint: rt.tokenizeEndpoint || '',
      gatewayUrl: rt.gatewayUrl || '',
      output:
        body.output ||
        `[${rt.baseModel || dep.productName}] completion via ${rt.publicEndpoint || rt.serverlessEndpoint || 'runtime'} (${outputTokens} tokens)`,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/usage', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const dep = await findOwnedDeployment(req, res);
    if (!dep) return;
    const events = await UsageEvent.find({ deployment: dep._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({
      totals: toPublic(dep).totals,
      events: events.map((e) => ({
        id: e._id.toString(),
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cost: e.cost,
        sellerNet: e.sellerNet,
        createdAt: new Date(e.createdAt).toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
