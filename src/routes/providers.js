const express = require('express');
const { publicHttps, enabled, baseDomain } = require('../utils/proxvn');
const { fetchRegistry } = require('../utils/provider-registry');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const capability = req.query.capability ? String(req.query.capability) : '';
    const providers = await fetchRegistry(capability);
    res.json({
      ok: true,
      proxvn: {
        enabled: enabled(),
        domain: enabled() ? baseDomain() : '',
        exampleStream: publicHttps('gs', 'demo') || null,
        exampleApi: publicHttps('api', 'demo-model') || null,
      },
      providers,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
