const express = require('express');
const GpuServer = require('../models/GpuServer');
const Product = require('../models/Product');
const { authenticate, requireRoles } = require('../middleware/auth');
const { assertSafeHttpUrl, assertSafeStreamHost } = require('../utils/safe-http-url');
const {
  resolveProduct,
  findComputeNode,
  registerComputeNode,
  registerExternalNode,
  registerHostedNode,
  publicNode,
  sellerNodeConfig,
  ensureHostedNodeReady,
  isComputeCategory,
  parseMobileStream,
  syncProductDevices,
} = require('../utils/compute-session');
const { normalizeDevices, PROFILES } = require('../utils/stream-clients');
const provider = require('../utils/denglish-providers');

const router = express.Router();

router.use(authenticate, requireRoles('seller', 'admin'));

/**
 * The seller's own products for the "register compute node" picker, including
 * drafts, each flagged with whether it can carry a node and why not.
 */
router.get('/products', async (req, res, next) => {
  try {
    const rows = await Product.find({ creator: req.user._id })
      .select('slug name category published moderationStatus suspendedUntil')
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean();
    res.json(
      rows.map((p) => {
        const compute = isComputeCategory(p.category);
        const published = p.published !== false;
        const reason = !compute ? 'NOT_COMPUTE_CATEGORY' : !published ? 'NOT_PUBLISHED' : '';
        return {
          id: String(p._id),
          slug: p.slug,
          name: p.name,
          category: p.category,
          published,
          moderationStatus: p.moderationStatus || 'active',
          eligible: !reason,
          reason,
        };
      }),
    );
  } catch (e) {
    next(e);
  }
});

/** List compute nodes (external + AI Markets hosted) linked to products. */
router.get('/nodes', async (req, res, next) => {
  try {
    const rows = await GpuServer.find({ owner: req.user._id, product: { $ne: null } })
      .sort({ updatedAt: -1 })
      .lean();
    const productIds = [...new Set(rows.map((r) => String(r.product)).filter(Boolean))];
    const products = await Product.find({ _id: { $in: productIds } }).lean();
    const byId = Object.fromEntries(products.map((p) => [String(p._id), p]));
    res.json(
      rows.map((r) => ({
        ...publicNode({ ...r, id: String(r._id) }, byId[String(r.product)]),
        category: byId[String(r.product)]?.category || '',
        config: sellerNodeConfig(r),
      })),
    );
  } catch (e) {
    next(e);
  }
});

/** Register external webhook node or AI Markets–hosted RunPod pod. */
router.post('/nodes', async (req, res, next) => {
  try {
    const { product, node } = await registerComputeNode(req.user, req.body || {});
    res.status(201).json({ ...publicNode(node, product), config: sellerNodeConfig(node) });
  } catch (e) {
    if (e.status === 402) return res.status(402).json({ message: e.message, ...e.body });
    next(e);
  }
});

/** Provision RunPod pod via denglish-api for a product (shortcut). */
router.post('/nodes/hosted', async (req, res, next) => {
  try {
    const { product, node } = await registerHostedNode(req.user, req.body || {});
    res.status(201).json(publicNode(node, product));
  } catch (e) {
    next(e);
  }
});

router.patch('/nodes/:id', async (req, res, next) => {
  try {
    const node = await GpuServer.findOne({
      _id: req.params.id,
      owner: req.user._id,
      product: { $ne: null },
    });
    if (!node) return res.status(404).json({ message: 'Not found' });
    if (node.external) {
      const body = req.body || {};
      if (body.name) node.name = String(body.name).slice(0, 120);
      if (body.status) node.status = body.status === 'offline' ? 'offline' : 'online';
      if (body.webhookUrl !== undefined) {
        const url = String(body.webhookUrl).slice(0, 500);
        if (url) await assertSafeHttpUrl(url, { httpsOnly: true });
        node.webhookUrl = url;
      }
      // Blank = keep the stored secret (it is never sent back to the browser).
      if (body.webhookSecret !== undefined && String(body.webhookSecret).trim()) {
        const secret = String(body.webhookSecret).trim();
        if (secret.length < 16) {
          return res.status(400).json({ message: 'Webhook secret must be at least 16 characters', code: 'WEBHOOK_SECRET_TOO_SHORT' });
        }
        node.webhookSecret = secret.slice(0, 256);
      }
      if (body.clearWebhookSecret === true) node.webhookSecret = '';
      if (body.streamHost !== undefined) node.streamHost = assertSafeStreamHost(String(body.streamHost).slice(0, 200));
      if (body.streamPort !== undefined) node.streamPort = Number(body.streamPort) || 0;
      if (body.streamPath !== undefined) node.streamPath = String(body.streamPath).slice(0, 200);
      if (body.streamKind !== undefined) node.streamKind = String(body.streamKind).slice(0, 40);
      if (body.streamTls !== undefined) node.streamTls = !!body.streamTls;
      if (body.iframeUrl !== undefined) {
        const url = String(body.iframeUrl).slice(0, 500);
        if (url) await assertSafeHttpUrl(url, { httpsOnly: true });
        node.iframeUrl = url;
      }
      if (body.healthUrl !== undefined) {
        const url = String(body.healthUrl).slice(0, 500);
        if (url) await assertSafeHttpUrl(url);
        node.healthUrl = url;
      }
      if (body.region !== undefined) node.region = String(body.region).slice(0, 80);
      if (body.maxConcurrent !== undefined) {
        node.maxConcurrent = Math.min(100, Math.max(1, Number(body.maxConcurrent) || 10));
      }
      if (body.mobileStream !== undefined) node.mobileStream = await parseMobileStream(body.mobileStream);
    } else {
      const body = req.body || {};
      if (body.name) node.name = String(body.name).slice(0, 120);
      if (body.maxConcurrent !== undefined) {
        node.maxConcurrent = Math.min(100, Math.max(1, Number(body.maxConcurrent) || 5));
      }
      if (body.status === 'offline') node.status = 'offline';
    }
    if (req.body?.devices !== undefined) node.devices = normalizeDevices(req.body.devices);
    await node.save();
    await syncProductDevices(node.product);
    const product = node.product ? await Product.findById(node.product).lean() : null;
    res.json({ ...publicNode(node, product), config: sellerNodeConfig(node) });
  } catch (e) {
    next(e);
  }
});

router.delete('/nodes/:id', async (req, res, next) => {
  try {
    const node = await GpuServer.findOne({
      _id: req.params.id,
      owner: req.user._id,
      product: { $ne: null },
    });
    if (!node) return res.status(404).json({ message: 'Not found' });
    if (!node.external && node.provider !== 'external') {
      try {
        await provider.terminateProviderServer(node.provider, node.providerServerId);
      } catch (_) {
        /* still mark offline locally */
      }
    }
    node.status = 'offline';
    await node.save();
    await syncProductDevices(node.product);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Ping external health/webhook or hosted RunPod connection via denglish-api */
router.post('/nodes/:id/ping', async (req, res, next) => {
  try {
    const node = await GpuServer.findOne({
      _id: req.params.id,
      owner: req.user._id,
      product: { $ne: null },
    });
    if (!node) return res.status(404).json({ message: 'Not found' });

    if (!node.external) {
      await ensureHostedNodeReady(node);
      const conn = await provider.getConnection(node.provider, node.providerServerId);
      const stream = conn?.connection?.stream;
      return res.json({
        ok: true,
        via: 'hosted',
        status: conn?.connection?.status || node.status,
        hasStream: !!(stream?.host && stream?.port),
      });
    }

    const healthUrl = String(node.healthUrl || '').trim();
    if (healthUrl) {
      await assertSafeHttpUrl(healthUrl);
      const resHealth = await fetch(healthUrl, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
      return res.json({ ok: resHealth.ok, status: resHealth.status, via: 'health' });
    }
    if (node.webhookUrl) {
      const { callSellerWebhook } = require('../utils/compute-session');
      await callSellerWebhook(node, 'session.ping', { nodeId: node.providerServerId });
      return res.json({ ok: true, via: 'webhook' });
    }
    res.json({ ok: true, via: 'static', message: 'No health URL configured' });
  } catch (e) {
    res.status(502).json({ ok: false, message: e.message || 'Ping failed' });
  }
});

/** Docs payload for integrators */
router.get('/schema', (_req, res) => {
  res.json({
    registerExternalNode: {
      hosting: 'external',
      productSlug: 'your-product-slug',
      name: 'EU Game Box',
      kind: 'game',
      webhookUrl: 'https://seller.example.com/aimarkets/webhook',
      webhookSecret: 'replace-with-at-least-16-random-characters',
      streamHost: 'stream.your-domain.com',
      streamPort: 443,
      streamTls: true,
      devices: ['pc', 'mobile'],
      mobileStream: { host: 'mobile-stream.your-domain.com', port: 443, path: '/', kind: 'novnc', tls: true },
    },
    registerHostedNode: {
      hosting: 'aimarkets',
      productSlug: 'your-product-slug',
      name: 'Hosted Game Box',
      kind: 'game',
      gpuType: 'NVIDIA GeForce RTX 4090',
      devices: ['pc', 'mobile'],
      note: 'Provisions an AI Markets hosted GPU pod (ai.aimarkets.vn)',
    },
    buyerResolveOrder: {
      THIRD_PARTY_SELLER: ['external seller node', 'AI Markets hosted GPU pod'],
      PLATFORM_DIRECT: ['AI Markets hosted GPU pod', 'external node'],
    },
    devices: {
      pc: 'Web / desktop browser — keyboard + mouse',
      mobile: 'Android / iOS app — touch + virtual gamepad, landscape',
    },
    deviceProfiles: PROFILES,
    billing: {
      model: 'per-minute wallet debit while the session is live; seller receives net after platform fee',
      autoStop: ['insufficient_funds', 'idle (no client heartbeat)'],
    },
    webhookEvents: ['session.start', 'session.stop', 'session.ping'],
    webhookStartPayload: {
      sessionId: 'gs_…',
      productSlug: 'your-product-slug',
      client: 'android',
      device: 'mobile',
      profile: PROFILES.mobile,
    },
    webhookResponse: {
      streamHost: '10.0.0.5',
      streamPort: 6080,
      streamPath: '/',
      streamKind: 'novnc',
      streamTls: false,
    },
    buyerSession: {
      method: 'POST',
      path: '/v1/game-sessions',
      body: { productSlug: 'your-product-slug', client: 'pc | android | ios' },
      heartbeat: { method: 'POST', path: '/v1/game-sessions/:sessionId/heartbeat', everyMs: 30000 },
    },
    categories: ['gpu-compute', 'game-server'],
  });
});

module.exports = router;
