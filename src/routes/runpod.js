const express = require('express');
const {
  listRunpodPublicEndpoints,
  getRunpodPublicEndpoint,
} = require('../data/runpod-public-endpoints');
const { fetchModelSchema } = require('../utils/denglish-client');

const router = express.Router();

/**
 * GET /api/runpod/public-endpoints
 * Official RunPod Public Endpoints catalog (no auth).
 * Query: kind=image|video|text|audio, modality=text-to-image|…, q=
 */
router.get('/public-endpoints', (req, res) => {
  const { kind, modality, q } = req.query;
  res.json(
    listRunpodPublicEndpoints({
      kind: kind || undefined,
      modality: modality || undefined,
      q: q || undefined,
    })
  );
});

/**
 * GET /api/runpod/public-endpoints/:slug
 */
router.get('/public-endpoints/:slug', (req, res) => {
  const item = getRunpodPublicEndpoint(req.params.slug);
  if (!item) return res.status(404).json({ message: 'RunPod public endpoint not found' });
  return res.json(item);
});

/**
 * GET /v1/runpod/public-endpoints/:slug/schema
 * Full `input` schema + pricing formula, sourced from denglish-api's model registry.
 */
router.get('/public-endpoints/:slug/schema', async (req, res, next) => {
  const item = getRunpodPublicEndpoint(req.params.slug);
  if (!item) return res.status(404).json({ message: 'RunPod public endpoint not found' });
  try {
    const result = await fetchModelSchema(item.endpointId);
    return res.json(result.model || result);
  } catch (err) {
    if (err.code === 'DENGLISH_NOT_CONFIGURED' || err.status === 404) {
      return res.status(503).json({
        message: 'Model schema is unavailable (denglish-api)',
        endpointId: item.endpointId,
      });
    }
    return next(err);
  }
});

module.exports = router;
