const express = require('express');
const AgentTemplate = require('../models/AgentTemplate');

const router = express.Router();

const SEED = [
  {
    slug: 'openclaw',
    name: 'OpenClaw',
    repository: '',
    dockerImage: 'phai/openclaw:latest',
    requiredGPU: '',
    startupCommand: '',
    healthCheck: '/health',
  },
  {
    slug: 'hermes',
    name: 'Hermes',
    dockerImage: 'phai/hermes:latest',
    healthCheck: '/health',
  },
  {
    slug: 'spacebot',
    name: 'SpaceBot',
    dockerImage: 'phai/spacebot:latest',
    healthCheck: '/health',
  },
];

async function ensureTemplates() {
  for (const row of SEED) {
    await AgentTemplate.updateOne({ slug: row.slug }, { $setOnInsert: row }, { upsert: true });
  }
}

router.get('/', async (_req, res, next) => {
  try {
    await ensureTemplates();
    const rows = await AgentTemplate.find({ published: true }).sort({ name: 1 }).lean();
    res.json(
      rows.map((t) => ({
        agentId: String(t._id),
        slug: t.slug,
        name: t.name,
        repository: t.repository,
        dockerImage: t.dockerImage,
        version: t.version,
        environmentVariables: t.environmentVariables,
        ports: t.ports,
        volumes: t.volumes,
        requiredGPU: t.requiredGPU,
        requiredCPU: t.requiredCPU,
        requiredRAM: t.requiredRAM,
        providerRequirements: t.providerRequirements,
        startupCommand: t.startupCommand,
        healthCheck: t.healthCheck,
        configurationSchema: t.configurationSchema,
      }))
    );
  } catch (e) {
    next(e);
  }
});

module.exports = router;
