const express = require('express');
const { authenticate } = require('../middleware/auth');
const { authenticateMarketplaceKey } = require('../middleware/marketplace-key');
const { runCatalogModel, pollCatalogJob } = require('../utils/gateway-infer');

function authStack(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token.startsWith('mk_live_')) return authenticateMarketplaceKey(req, res, next);
  return authenticate(req, res, next);
}

function sendError(res, next, e) {
  if (e.status === 402) return res.status(402).json({ message: e.message, ...e.body });
  if (e.status === 403) return res.status(403).json({ message: e.message, ...e.body });
  if (e.status === 404) return res.status(404).json({ message: e.message, ...e.body });
  return next(e);
}

function attachRunRoutes(router, { idParam = 'id' } = {}) {
  router.post(`/:${idParam}/runsync`, authStack, async (req, res, next) => {
    try {
      res.json(await runCatalogModel(req, req.params[idParam], 'runsync'));
    } catch (e) {
      sendError(res, next, e);
    }
  });

  router.post(`/:${idParam}/run`, authStack, async (req, res, next) => {
    try {
      res.json(await runCatalogModel(req, req.params[idParam], 'run'));
    } catch (e) {
      sendError(res, next, e);
    }
  });

  router.get(`/:${idParam}/status/:jobId`, authStack, async (req, res, next) => {
    try {
      res.json(await pollCatalogJob(req, req.params[idParam], req.params.jobId));
    } catch (e) {
      sendError(res, next, e);
    }
  });

  router.post(`/:${idParam}/tokenize`, authStack, (_req, res) => {
    res.status(501).json({
      message: 'Tokenize is available via POST /v1/chat/completions on ai.aimarkets.vn',
      code: 'NOT_IMPLEMENTED',
    });
  });
}

const v1 = express.Router();
attachRunRoutes(v1);

const v2 = express.Router();
attachRunRoutes(v2);

module.exports = { v1, v2, authStack };
