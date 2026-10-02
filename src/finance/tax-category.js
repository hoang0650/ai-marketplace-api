const TAX_CATEGORIES = [
  'AI_API',
  'AI_SAAS',
  'AI_MODEL',
  'AI_AGENT',
  'DATASET',
  'GPU_COMPUTE',
  'TRAINING',
  'FINE_TUNING',
  'CONTAINER',
  'HOSTING',
  'GAME_SERVER',
  'DIGITAL_GOODS',
  'SOFTWARE_LICENSE',
  'VOICE',
  'MEDIA_LICENSE',
  'OTHER',
];

const PRODUCT_TYPE_MAP = {
  MODEL: 'AI_MODEL',
  API: 'AI_API',
  AGENT: 'AI_AGENT',
  DATASET: 'DATASET',
  GPU: 'GPU_COMPUTE',
  TRAINING: 'TRAINING',
  SOFTWARE: 'SOFTWARE_LICENSE',
  VOICE: 'VOICE',
  MEDIA_LICENSE: 'MEDIA_LICENSE',
};

const CATEGORY_MAP = {
  'api-endpoint': 'AI_API',
  inference: 'AI_API',
  'gpu-compute': 'GPU_COMPUTE',
  'game-server': 'GAME_SERVER',
  'training-service': 'TRAINING',
  'agent-runtime': 'AI_AGENT',
  dataset: 'DATASET',
  'hire-agent': 'AI_AGENT',
  'skill-pack': 'SOFTWARE_LICENSE',
  'template-web': 'SOFTWARE_LICENSE',
  'template-app': 'SOFTWARE_LICENSE',
  'voice-clone': 'VOICE',
  'voice-preset': 'VOICE',
  'ai-film-series': 'MEDIA_LICENSE',
  'story-book': 'MEDIA_LICENSE',
};

function taxCategoryFromProduct(product = {}) {
  const explicit = String(product.taxCategory || '').toUpperCase();
  if (TAX_CATEGORIES.includes(explicit)) return explicit;
  const pt = String(product.productType || '').toUpperCase();
  if (PRODUCT_TYPE_MAP[pt]) return PRODUCT_TYPE_MAP[pt];
  if (CATEGORY_MAP[product.category]) return CATEGORY_MAP[product.category];
  if (String(product.category || '').startsWith('text-') || String(product.category || '').includes('image')) {
    return 'AI_MODEL';
  }
  return 'OTHER';
}

module.exports = { TAX_CATEGORIES, taxCategoryFromProduct };
