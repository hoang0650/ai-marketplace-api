const denglish = require('./denglish-providers');

const FALLBACK = [
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    capabilities: ['AI_API', 'MODEL_INFERENCE'],
    inference: true,
    compute: false,
    status: 'active',
  },
  {
    provider: 'featherless',
    label: 'Featherless AI',
    capabilities: ['AI_API', 'MODEL_INFERENCE', 'MODEL_HOSTING'],
    inference: true,
    compute: false,
    status: 'active',
  },
  {
    provider: 'runpod',
    label: 'RunPod',
    capabilities: [
      'GPU_COMPUTE',
      'SERVERLESS',
      'CONTAINER',
      'SSH',
      'GAME_STREAM',
      'MODEL_DEPLOYMENT',
      'AGENT_DEPLOYMENT',
      'TRAINING',
      'MODEL_INFERENCE',
    ],
    inference: true,
    compute: true,
    status: 'active',
  },
  {
    provider: 'runpod_public',
    label: 'RunPod Public Endpoints',
    capabilities: ['AI_API', 'MODEL_INFERENCE', 'SERVERLESS'],
    inference: true,
    compute: false,
    status: 'active',
  },
  {
    provider: 'vast',
    label: 'Vast.ai',
    capabilities: ['GPU_COMPUTE', 'CONTAINER', 'SSH', 'TRAINING'],
    inference: false,
    compute: true,
    status: 'planned',
  },
  {
    provider: 'lambda',
    label: 'Lambda Labs',
    capabilities: ['GPU_COMPUTE', 'CONTAINER', 'SSH'],
    inference: false,
    compute: true,
    status: 'planned',
  },
  {
    provider: 'aws',
    label: 'AWS',
    capabilities: ['GPU_COMPUTE', 'CONTAINER', 'SERVERLESS', 'DATASET_STORAGE'],
    inference: false,
    compute: true,
    status: 'planned',
  },
  {
    provider: 'gcp',
    label: 'Google Cloud',
    capabilities: ['GPU_COMPUTE', 'CONTAINER', 'SERVERLESS', 'DATASET_STORAGE'],
    inference: false,
    compute: true,
    status: 'planned',
  },
];

async function fetchRegistry(capability) {
  try {
    const json = await denglish.listProviderRegistry(capability);
    if (json?.providers?.length) return json.providers;
  } catch (_) {
    /* offline Python */
  }
  if (!capability) return FALLBACK;
  const cap = String(capability).toUpperCase();
  return FALLBACK.filter((p) => (p.capabilities || []).includes(cap));
}

module.exports = { fetchRegistry, FALLBACK };
