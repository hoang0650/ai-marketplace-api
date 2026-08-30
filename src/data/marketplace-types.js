/** Infrastructure product kinds — not provider-specific. */
const PRODUCT_TYPES = [
  'API_ENDPOINT',
  'MODEL',
  'AGENT',
  'DATASET',
  'GPU',
  'SERVERLESS_ENDPOINT',
  'TRAINING_SERVICE',
  'FINE_TUNING_SERVICE',
  'GAME_SERVER',
  'GAME_STREAM',
  'CONTAINER',
  'AI_APPLICATION',
];

const USAGE_TYPES = [
  'API_REQUEST',
  'INPUT_TOKEN',
  'OUTPUT_TOKEN',
  'GPU_SECOND',
  'GPU_MINUTE',
  'GPU_HOUR',
  'STORAGE_GB',
  'BANDWIDTH_GB',
  'TRAINING_TIME',
  'DATASET_DOWNLOAD',
  'AGENT_RUNTIME',
  'GAME_RUNTIME',
];

const DEPLOYMENT_RUNTIMES = ['DOCKER', 'SERVERLESS', 'GPU_VM', 'POD', 'CONTAINER', 'GAME_SERVER'];

function inferProductType(category, tags = []) {
  const c = String(category || '');
  const t = tags.map((x) => String(x).toLowerCase());
  if (c === 'api-endpoint' || t.includes('api-endpoint')) return 'API_ENDPOINT';
  if (c === 'dataset') return 'DATASET';
  if (c === 'fine-tune' || c === 'training-service') return 'FINE_TUNING_SERVICE';
  if (c === 'hire-agent' || c === 'agent-runtime') return 'AGENT';
  if (c === 'gpu-compute') return 'GPU';
  if (c === 'game-server') return 'GAME_SERVER';
  if (c === 'inference') return 'SERVERLESS_ENDPOINT';
  if (c === 'openrouter' || c === 'featherless' || c === 'runpod-public') return 'API_ENDPOINT';
  if (c.startsWith('text-') || c.startsWith('image-')) return 'MODEL';
  return 'AI_APPLICATION';
}

module.exports = { PRODUCT_TYPES, USAGE_TYPES, DEPLOYMENT_RUNTIMES, inferProductType };
