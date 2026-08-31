const express = require('express');
const GpuServer = require('../models/GpuServer');
const Product = require('../models/Product');
const { authenticate, requireRoles } = require('../middleware/auth');
const {
  resolveProduct,
  registerExternalNode,
  publicNode,
  isComputeCategory,
} = require('../utils/compute-session');

const router = express.Router();

router.use(authenticate, requireRoles('creator', 'admin'));

/** List external compute nodes registered by this seller. */
router.get('/nodes', async (req, res, next) => {
  try {
    const rows = await GpuServer.find({ owner: req.user._id, external: true }).sort({ updatedAt: -1 }).lean();
    const productIds = [...new Set(rows.map((r) => String(r.product)).filter(Boolean))];
    const products = await Product.find({ _id: { $in: productIds } }).lean();
    const byId = Object.fromEntries(products.map((p) => [String(p._id), p]));
    res.json(rows.map((r) => publicNode({ ...r, id: String(r._id) }, byId[String(r.product)])));
  } catch (e) {
    next(e);
  }
});

/** Register an external GPU/game node for a marketplace product. */
router.post('/nodes', async (req, res, next) => {
  try {
    const { product, node } = await registerExternalNode(req.user, req.body || {});
    res.status(201).json(publicNode(node, product));
  } catch (e) {
    if (e.status === 402) return res.status(402).json({ message: e.message, ...e.body });
    next(e);
  }
});

router.patch('/nodes/:id', async (req, res, next) => {
  try {
    const node = await GpuServer.findOne({ _id: req.params.id, owner: req.user._id, external: true });
    if (!node) return res.status(404).json({ message: 'Not found' });
    const body = req.body || {};
    if (body.name) node.name = String(body.name).slice(0, 120);
    if (body.status) node.status = body.status === 'offline' ? 'offline' : 'online';
    if (body.webhookUrl !== undefined) node.webhookUrl = String(body.webhookUrl).slice(0, 500);
    if (body.webhookSecret !== undefined) node.webhookSecret = String(body.webhookSecret).slice(0, 256);
    if (body.streamHost !== undefined) node.streamHost = String(body.streamHost).slice(0, 200);
    if (body.streamPort !== undefined) node.streamPort = Number(body.streamPort) || 0;
    if (body.streamPath !== undefined) node.streamPath = String(body.streamPath).slice(0, 200);
    if (body.streamKind !== undefined) node.streamKind = String(body.streamKind).slice(0, 40);
    if (body.streamTls !== undefined) node.streamTls = !!body.streamTls;
    if (body.iframeUrl !== undefined) node.iframeUrl = String(body.iframeUrl).slice(0, 500);
    if (body.healthUrl !== undefined) node.healthUrl = String(body.healthUrl).slice(0, 500);
    if (body.region !== undefined) node.region = String(body.region).slice(0, 80);
    if (body.maxConcurrent !== undefined) node.maxConcurrent = Math.min(100, Math.max(1, Number(body.maxConcurrent) || 10));
    await node.save();
    const product = node.product ? await Product.findById(node.product).lean() : null;
    res.json(publicNode(node, product));
  } catch (e) {
    next(e);
  }
});

router.delete('/nodes/:id', async (req, res, next) => {
  try {
    const node = await GpuServer.findOne({ _id: req.params.id, owner: req.user._id, external: true });
    if (!node) return res.status(404).json({ message: 'Not found' });
    node.status = 'offline';
    await node.save();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Ping seller health URL or webhook with session.ping */
router.post('/nodes/:id/ping', async (req, res, next) => {
  try {
    const node = await GpuServer.findOne({ _id: req.params.id, owner: req.user._id, external: true });
    if (!node) return res.status(404).json({ message: 'Not found' });
    const healthUrl = String(node.healthUrl || '').trim();
    if (healthUrl) {
      const resHealth = await fetch(healthUrl, { signal: AbortSignal.timeout(8000) });
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
    registerNode: {
      productSlug: 'your-product-slug',
      name: 'EU Game Box',
      kind: 'game',
      nodeId: 'optional-external-id',
      webhookUrl: 'https://seller.example.com/aimarkets/webhook',
      webhookSecret: 'whsec_...',
      streamHost: '10.0.0.5',
      streamPort: 6080,
      streamPath: '/',
      streamKind: 'novnc',
      healthUrl: 'https://seller.example.com/health',
      region: 'eu-west',
    },
    webhookEvents: ['session.start', 'session.stop', 'session.ping'],
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
      body: { productSlug: 'your-product-slug' },
    },
    categories: ['gpu-compute', 'game-server'],
  });
});

module.exports = router;
