const express = require('express');
const crypto = require('crypto');
const Deployment = require('../models/Deployment');
const UsageEvent = require('../models/UsageEvent');
const Product = require('../models/Product');
const WalletTx = require('../models/WalletTx');
const UsageStat = require('../models/UsageStat');
const Notification = require('../models/Notification');
const { authenticate } = require('../middleware/auth');
const { PLATFORM_FEE_RATE } = require('../utils/platform');
const { getBalance } = require('../utils/wallet');
const { slugify } = require('../utils/serialize');

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
const RUN_BASE = process.env.RUN_BASE_URL || 'https://run.phaimarket.com/v1';

function kindForCategory(category) {
  if (MODEL_CATEGORIES.includes(category)) return 'model';
  if (AGENT_CATEGORIES.includes(category)) return 'agent';
  return null;
}

/** ~4 chars per token — used when the caller doesn't report exact token counts. */
function estimateTokens(text) {
  const s = String(text || '');
  return s.length === 0 ? 0 : Math.max(1, Math.ceil(s.length / 4));
}

/** USD cost for a usage-priced product: usageRate is per 1K tokens. */
function computeCost(product, totalTokens) {
  if (product.pricing?.model !== 'usage') return 0;
  const rate = Number(product.pricing.usageRate) || 0;
  return Math.round(((totalTokens / 1000) * rate) * 1e6) / 1e6;
}

function toPublic(dep, { includeSecrets = false } = {}) {
  return {
    id: dep._id.toString(),
    name: dep.name,
    slug: dep.slug,
    kind: dep.kind,
    status: dep.status,
    visibility: dep.visibility,
    productSlug: dep.productSlug,
    productName: dep.productName,
    ownerName: dep.ownerName || undefined,
    config: {
      baseModel: dep.config?.baseModel || '',
      systemPrompt: dep.config?.systemPrompt || '',
      temperature: dep.config?.temperature ?? 0.7,
      maxTokens: dep.config?.maxTokens ?? 1024,
      tools: dep.config?.tools || [],
    },
    endpoint: dep.endpoint,
    ...(includeSecrets ? { apiKey: dep.apiKey } : {}),
    totals: {
      requests: dep.totals?.requests || 0,
      inputTokens: dep.totals?.inputTokens || 0,
      outputTokens: dep.totals?.outputTokens || 0,
      cost: Math.round((dep.totals?.cost || 0) * 100) / 100,
    },
    createdAt: dep.createdAt ? new Date(dep.createdAt).toISOString() : undefined,
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

/** Deploy a product (model or agent) with a user-supplied configuration. */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const body = req.body || {};
    const product = await Product.findById(body.productId).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const kind = kindForCategory(product.category);
    if (!kind) {
      return res.status(400).json({ message: `Category "${product.category}" is not deployable` });
    }

    const name = String(body.name || product.name).trim().slice(0, 120);
    let slug = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;

    const cfg = body.config || {};
    const deployment = await Deployment.create({
      owner: req.user._id,
      product: product._id,
      productSlug: product.slug,
      productName: product.name,
      seller: product.creator,
      kind,
      name,
      slug,
      status: 'running', // provisioning is instant in the simulated runtime
      visibility: body.visibility === 'public' ? 'public' : 'private',
      config: {
        baseModel: String(cfg.baseModel || product.name).slice(0, 200),
        systemPrompt: String(cfg.systemPrompt || '').slice(0, 4000),
        temperature: Math.min(Math.max(Number(cfg.temperature) || 0.7, 0), 2),
        maxTokens: Math.min(Math.max(Number(cfg.maxTokens) || 1024, 1), 32768),
        tools: Array.isArray(cfg.tools) ? cfg.tools.slice(0, 20).map(String) : [],
      },
      apiKey: `pk_${crypto.randomBytes(24).toString('hex')}`,
      endpoint: `${RUN_BASE}/${slug}`,
    });

    res.status(201).json(toPublic(deployment, { includeSecrets: true }));
  } catch (err) {
    next(err);
  }
});

/** My deployments (secrets included — owner only). */
router.get('/mine', authenticate, async (req, res, next) => {
  try {
    const rows = await Deployment.find({ owner: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json(rows.map((d) => toPublic({ ...d, _id: d._id }, { includeSecrets: true })));
  } catch (err) {
    next(err);
  }
});

/** Public Agent Browser — running, publicly published deployments. */
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

/** Update config / rename / start / stop / publish / unpublish. */
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const dep = await findOwnedDeployment(req, res);
    if (!dep) return;

    const body = req.body || {};
    if (body.name) dep.name = String(body.name).trim().slice(0, 120);
    if (body.status && ['running', 'stopped'].includes(body.status)) dep.status = body.status;
    if (body.visibility && ['private', 'public'].includes(body.visibility)) {
      dep.visibility = body.visibility;
    }
    if (body.config && typeof body.config === 'object') {
      const cfg = body.config;
      if (cfg.baseModel !== undefined) dep.config.baseModel = String(cfg.baseModel).slice(0, 200);
      if (cfg.systemPrompt !== undefined) dep.config.systemPrompt = String(cfg.systemPrompt).slice(0, 4000);
      if (cfg.temperature !== undefined) {
        dep.config.temperature = Math.min(Math.max(Number(cfg.temperature) || 0, 0), 2);
      }
      if (cfg.maxTokens !== undefined) {
        dep.config.maxTokens = Math.min(Math.max(Number(cfg.maxTokens) || 1024, 1), 32768);
      }
      if (Array.isArray(cfg.tools)) dep.config.tools = cfg.tools.slice(0, 20).map(String);
    }
    await dep.save();
    res.json(toPublic(dep, { includeSecrets: true }));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticate, async (req, res, next) => {
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
 * Metered invocation — the billing heart of the marketplace.
 *
 * Tokens: taken from the caller when reported (inputTokens/outputTokens),
 * otherwise estimated from input/output text (~4 chars per token).
 * Billing (usage-priced products only):
 *   cost      = tokens/1000 × pricing.usageRate  → debited from buyer wallet
 *   sellerNet = cost − 20% platform fee          → credited to creator wallet
 * Every invocation is recorded as a UsageEvent (audit trail) and rolled up
 * into UsageStat (creator dashboard) + deployment totals.
 */
router.post('/:id/invoke', authenticate, async (req, res, next) => {
  try {
    const dep = await Deployment.findById(req.params.id);
    if (!dep) return res.status(404).json({ message: 'Deployment not found' });
    if (dep.status !== 'running') {
      return res.status(409).json({ message: 'Deployment is not running' });
    }
    // Private deployments are callable only by their owner (or admin).
    if (
      dep.visibility !== 'public' &&
      req.user.role !== 'admin' &&
      String(dep.owner) !== String(req.user._id)
    ) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const body = req.body || {};
    const inputTokens = Number.isFinite(Number(body.inputTokens))
      ? Math.max(0, Math.floor(Number(body.inputTokens)))
      : estimateTokens(body.input);
    const outputTokens = Number.isFinite(Number(body.outputTokens))
      ? Math.max(0, Math.floor(Number(body.outputTokens)))
      : Math.min(dep.config.maxTokens, Math.max(estimateTokens(body.input) * 2, 16));
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
      // Same 20% take-rate as splitRevenue, but with micro-amount precision.
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
    });

    // Roll up into creator daily stats (dashboard) + deployment totals.
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
      output:
        body.output ||
        `[${dep.config.baseModel || dep.productName}] simulated completion (${outputTokens} tokens)`,
    });
  } catch (err) {
    next(err);
  }
});

/** Usage history + totals for one deployment (owner only). */
router.get('/:id/usage', authenticate, async (req, res, next) => {
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
