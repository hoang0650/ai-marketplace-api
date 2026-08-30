const { getRunpodPublicEndpoint } = require('../data/runpod-public-endpoints');
const {
  extractAimarketsModelId,
  extractProviderEndpointId,
  isAimarketsUrl,
  isProviderUrl,
  upstreamFromEnv,
} = require('./gateway-urls');

/**
 * Map a marketplace product onto a denglish-api provider + endpoint.
 * Public URLs may be api.aimarkets.vn — resolve upstream via env or catalog.
 */
function resolveProviderForProduct(product) {
  const slug = String(product.slug || '');
  const tags = product.tags || [];
  const runtime = product.runtime || {};
  const upstream = upstreamFromEnv(runtime.env || []);
  const publicUrl = upstream.runsync || runtime.publicEndpoint || '';
  const serverlessUrl = upstream.run || runtime.serverlessEndpoint || '';

  const aimarketsId =
    extractAimarketsModelId(runtime.publicEndpoint) ||
    extractAimarketsModelId(runtime.serverlessEndpoint) ||
    '';

  if (upstream.provider) {
    return {
      provider: upstream.provider,
      endpointId:
        upstream.endpointId ||
        extractProviderEndpointId(publicUrl || serverlessUrl) ||
        aimarketsId ||
        runtime.baseModel ||
        slug.replace(/^runpod-/, ''),
      model: runtime.baseModel || '',
    };
  }

  const providerEnv = (runtime.env || []).find((e) => e.key === 'AI_PROVIDER');
  if (providerEnv?.value) {
    return {
      provider: providerEnv.value,
      endpointId:
        upstream.endpointId ||
        extractProviderEndpointId(publicUrl || serverlessUrl) ||
        aimarketsId ||
        runtime.baseModel ||
        slug,
      model: runtime.baseModel || '',
    };
  }

  if (tags.includes('openrouter') || slug.includes('openrouter') || product.category === 'openrouter') {
    return { provider: 'openrouter', endpointId: '', model: runtime.baseModel || slug };
  }
  if (tags.includes('featherless') || slug.includes('featherless') || product.category === 'featherless') {
    return { provider: 'featherless', endpointId: '', model: runtime.baseModel || slug };
  }
  if (tags.includes('vercel') || tags.includes('vercel-gateway') || slug.includes('vercel')) {
    return { provider: 'vercel_gateway', endpointId: '', model: runtime.baseModel || slug };
  }

  if (slug.includes('denglish') || tags.includes('denglish') || tags.includes('runpod-serverless')) {
    return {
      provider: 'runpod_serverless',
      endpointId: extractProviderEndpointId(serverlessUrl || publicUrl) || upstream.endpointId || '',
      model: runtime.baseModel || 'denglish-lora',
    };
  }

  if (
    slug.startsWith('runpod-') ||
    tags.includes('public-endpoint') ||
    isProviderUrl(publicUrl) ||
    isAimarketsUrl(runtime.publicEndpoint) ||
    isAimarketsUrl(runtime.serverlessEndpoint)
  ) {
    const catalogSlug = slug.replace(/^runpod-/, '') || aimarketsId;
    const ep =
      getRunpodPublicEndpoint(catalogSlug) ||
      getRunpodPublicEndpoint(upstream.endpointId) ||
      getRunpodPublicEndpoint(aimarketsId) ||
      getRunpodPublicEndpoint(publicUrl);
    return {
      provider: 'runpod_public',
      endpointId: ep?.endpointId || upstream.endpointId || extractProviderEndpointId(publicUrl) || catalogSlug,
      model: ep?.openaiModel || runtime.baseModel || ep?.name || catalogSlug,
    };
  }

  if (upstream.gateway || (runtime.gatewayUrl && /featherless|vercel|openai|openrouter/i.test(runtime.gatewayUrl))) {
    const g = upstream.gateway || runtime.gatewayUrl;
    let provider = 'vercel_gateway';
    if (/featherless/i.test(g)) provider = 'featherless';
    else if (/openrouter/i.test(g)) provider = 'openrouter';
    return { provider, endpointId: '', model: runtime.baseModel || slug };
  }

  if (isProviderUrl(publicUrl)) {
    return {
      provider: 'runpod_public',
      endpointId: extractProviderEndpointId(publicUrl),
      model: runtime.baseModel || slug,
    };
  }
  return {
    provider: 'runpod_serverless',
    endpointId: extractProviderEndpointId(serverlessUrl || publicUrl) || '',
    model: runtime.baseModel || slug,
  };
}

function extractEndpointId(url) {
  return extractProviderEndpointId(url) || extractAimarketsModelId(url);
}

/**
 * Compute USD charge from product pricing + normalized usage.
 */
function computeUsageCost(product, usage, input = {}) {
  const pricing = product.pricing || {};
  if (pricing.model !== 'usage') return 0;

  const unit = usage?.unit || pricing.usageUnit || 'tokens';
  const rate = Number(pricing.usageRate) || 0;
  const quantity = Number(usage?.quantity);
  const totalTokens = Number(usage?.total_tokens) || 0;

  const slug = String(product.slug || '');
  if (slug.includes('seedance') && unit === 'seconds') {
    const secs = Number.isFinite(quantity) && quantity > 0 ? quantity : Number(input.duration) || 5;
    const res = String(input.resolution || '720p');
    const perSec = res === '480p' ? 0.024 : 0.052;
    return Math.round(secs * perSec * 1e6) / 1e6;
  }

  if (unit === 'seconds' || unit === 'images' || unit === 'requests') {
    const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : unit === 'images' ? 1 : 0;
    return Math.round(qty * rate * 1e6) / 1e6;
  }

  return Math.round((totalTokens / 1000) * rate * 1e6) / 1e6;
}

module.exports = { resolveProviderForProduct, extractEndpointId, computeUsageCost };
