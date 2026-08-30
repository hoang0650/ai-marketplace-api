const GpuServer = require('../models/GpuServer');
const { authenticate, requireRoles } = require('../middleware/auth');
const provider = require('../utils/denglish-providers');
const { assertServerOwner, newSessionId } = require('../terminal/permission.service');
const { proxyToStream } = require('../terminal/stream-proxy');

const express = require('express');
const router = express.Router();

function publicServer(doc, live = {}) {
  return {
    id: doc.id || String(doc._id),
    projectId: doc.projectId,
    name: doc.name,
    provider: doc.provider,
    kind: doc.kind,
    status: live.status || doc.status,
    gpu: live.gpu || doc.gpu,
    createdAt: doc.createdAt,
  };
}

router.use(authenticate, requireRoles('creator', 'admin'));

router.get('/', async (req, res, next) => {
  try {
    const projectId = String(req.query.projectId || 'default');
    const rows = await GpuServer.find({ owner: req.user._id, projectId }).sort({ createdAt: -1 }).lean();
    res.json(rows.map((r) => publicServer({ ...r, id: String(r._id) })));
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body?.name || 'GPU server').slice(0, 120);
    const kind = req.body?.kind === 'game' ? 'game' : 'compute';
    const projectId = String(req.body?.projectId || 'default');
    const providerName = String(req.body?.provider || 'runpod').toLowerCase();
    const created = await provider.createProviderServer(providerName, {
      name,
      kind,
      gpuType: req.body?.gpuType,
      image: req.body?.image,
      ports: kind === 'game' ? '22/tcp,8080/http,6080/http' : '22/tcp',
    });
    const remote = created.server || {};
    const doc = await GpuServer.create({
      owner: req.user._id,
      projectId,
      name: remote.name || name,
      provider: providerName,
      providerServerId: remote.id,
      kind,
      status: remote.status || 'creating',
      gpu: remote.gpu || '',
    });
    res.status(201).json(publicServer(doc, remote));
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const server = await assertServerOwner(req.user, req.params.id);
    let live = {};
    try {
      const remote = await provider.getProviderServer(server.provider, server.providerServerId);
      live = remote.server || {};
      if (live.status && live.status !== server.status) {
        server.status = live.status;
        await server.save();
      }
    } catch (_) {
      /* keep local */
    }
    res.json(publicServer(server, live));
  } catch (e) {
    next(e);
  }
});

router.post('/:id/start', async (req, res, next) => {
  try {
    const server = await assertServerOwner(req.user, req.params.id);
    const remote = await provider.startProviderServer(server.provider, server.providerServerId);
    server.status = remote?.server?.status || 'running';
    await server.save();
    res.json(publicServer(server, remote.server));
  } catch (e) {
    next(e);
  }
});

router.post('/:id/stop', async (req, res, next) => {
  try {
    const server = await assertServerOwner(req.user, req.params.id);
    const remote = await provider.stopProviderServer(server.provider, server.providerServerId);
    server.status = remote?.server?.status || 'stopped';
    await server.save();
    res.json(publicServer(server, remote.server));
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const server = await assertServerOwner(req.user, req.params.id);
    try {
      await provider.terminateProviderServer(server.provider, server.providerServerId);
    } catch (_) {
      /* still drop local record */
    }
    await GpuServer.deleteOne({ _id: server._id });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = { router, publicServer, proxyToStream, newSessionId };
