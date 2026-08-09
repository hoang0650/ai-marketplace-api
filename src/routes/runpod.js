const express = require('express');
const {
  listRunpodPublicEndpoints,
  getRunpodPublicEndpoint,
} = require('../data/runpod-public-endpoints');

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

module.exports = router;
