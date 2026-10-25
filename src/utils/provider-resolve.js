const { getRunpodPublicEndpoint } = require('../data/runpod-public-endpoints');
const { isVoiceCategory } = require('./license-keys');
const { voiceCloneProvider } = require('./voice-clone');
const { catalogModelSlug, isCatalogProductSlug } = require('./product-slug');
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
  if (isVoiceCategory(product?.category)) {
    return voiceCloneProvider();
  }
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
        catalogModelSlug(slug),
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
    isCatalogProductSlug(slug) ||
    tags.includes('public-endpoint') ||
    isProviderUrl(publicUrl) ||
    isAimarketsUrl(runtime.publicEndpoint) ||
    isAimarketsUrl(runtime.serverlessEndpoint)
  ) {
    const catalogSlug = catalogModelSlug(slug) || aimarketsId;
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
 * Buyer-supplied provider/model/endpoint hints are honoured only when the listing allows
 * them (its own route, `runtime.allowedModels` / `runtime.allowedEndpoints`, or the catalog
 * model id). Anything else is ignored so a buyer can never route a cheap listing to an
 * expensive upstream model, a different provider or another seller's endpoint.
 */
function applyAllowedOverrides(product, resolved, requested = {}) {
  const runtime = product?.runtime || {};
  const list = (v) => (Array.isArray(v) ? v : []).map((x) => String(x || '').trim()).filter(Boolean);
  const ep = getRunpodPublicEndpoint(resolved.endpointId) || getRunpodPublicEndpoint(catalogModelSlug(String(product?.slug || '')));
  const modelAllow = new Set(
    [resolved.model, product?.slug, runtime.baseModel, ep?.openaiModel, ...list(runtime.allowedModels)]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
  );
  const endpointAllow = new Set([resolved.endpointId, ...list(runtime.allowedEndpoints)].map((x) => String(x || '').trim()).filter(Boolean));

  const wantModel = String(requested.model || '').trim();
  const wantEndpoint = String(requested.endpointId || '').trim();
  const wantProvider = String(requested.provider || '').trim();

  const model = wantModel && modelAllow.has(wantModel) ? wantModel : resolved.model;
  const endpointId = wantEndpoint && endpointAllow.has(wantEndpoint) ? wantEndpoint : resolved.endpointId;
  const provider = resolved.provider;
  const ignored = [];
  if (wantProvider && wantProvider !== resolved.provider) ignored.push('provider');
  if (wantModel && !modelAllow.has(wantModel)) ignored.push('model');
  if (wantEndpoint && !endpointAllow.has(wantEndpoint)) ignored.push('endpointId');
  // A different (allowed) endpoint or an extra allowlisted model is a real reroute.
  const baseline = new Set([resolved.model, product?.slug, runtime.baseModel].map((x) => String(x || '').trim()).filter(Boolean));
  const rerouted = endpointId !== resolved.endpointId || (Boolean(wantModel) && modelAllow.has(wantModel) && !baseline.has(wantModel));
  return { provider, model, endpointId, rerouted, ignored };
}

const { toUsd, charCount, tokenUnitSize, charUnitSize, timeUnitSeconds } = require('./usage-pricing');

const round6 = (value) => Math.round(Number(value) * 1e6) / 1e6;

/**
 * Compute the USD charge from product pricing + normalized usage.
 *
 * When the seller has set `pricing.usageRate` we bill against it. Otherwise we
 * fall back to `providerCost` — the figure RunPod reports in `output.cost`
 * (or denglish-api's estimate from the model's documented pricing formula) —
 * so pay-per-use products stay in sync with the upstream price list.
 */
function computeUsageCost(product, usage, input = {}, providerCost = 0) {
  const pricing = product.pricing || {};
  const voice = isVoiceCategory(product?.category);
  // Voice listings: per-character even when the catalog also sells day/month/year licenses.
  if (pricing.model !== 'usage' && !voice) return 0;
  // Sandbox / echo responses never reach a real model — never bill them.
  if (usage?.sandbox) return 0;

  const currency = pricing.currency || 'USD';
  const productUnit = String(pricing.usageUnit || (voice ? 'characters' : 'tokens'));
  const unit = String(usage?.unit || productUnit);
  const rate = toUsd(Number(pricing.usageRate) || 0, currency);
  const inputRate = toUsd(Number(pricing.inputRate) || 0, currency);
  const outputRate = toUsd(Number(pricing.outputRate) || 0, currency);
  const quantity = Number(usage?.quantity);

  if (rate > 0 || inputRate > 0 || outputRate > 0) {
    if (/char/i.test(unit) || voice) {
      const chars =
        Number.isFinite(quantity) && quantity > 0 ? quantity : charCount(input?.prompt || input?.text || '');
      if (!(chars > 0)) return 0;
      const metaPer = Number(product?.contentMeta?.charactersPerCredit);
      const perCredit = Math.max(1, metaPer > 0 ? metaPer : charUnitSize(productUnit));
      return round6((chars / perCredit) * rate);
    }
    if (unit === 'seconds' || unit === 'images' || unit === 'requests') {
      let qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
      if (!qty) qty = unit === 'seconds' ? Number(input?.duration) || 0 : 1;
      if (unit === 'seconds') {
        // Seller may price per minute/hour ("phút", "/min", "GPU hour"…): scale seconds to that unit.
        const per = timeUnitSeconds(productUnit);
        if (per && per !== 1) qty /= per;
      }
      return round6(qty * rate);
    }
    const size = tokenUnitSize(productUnit);
    const inTok = Number(usage?.input_tokens ?? usage?.prompt_tokens) || 0;
    const outTok = Number(usage?.output_tokens ?? usage?.completion_tokens) || 0;
    const totalTokens = Number(usage?.total_tokens) || inTok + outTok;
    if (inputRate > 0 || outputRate > 0) {
      // Separate prompt/completion prices; a missing side falls back to the flat usageRate.
      const inR = inputRate > 0 ? inputRate : rate;
      const outR = outputRate > 0 ? outputRate : rate;
      const split = inTok || outTok ? inTok * inR + outTok * outR : totalTokens * Math.max(inR, outR);
      return round6(split / size);
    }
    return round6((totalTokens / size) * rate);
  }

  const upstream = Number(providerCost);
  return Number.isFinite(upstream) && upstream > 0 ? round6(upstream) : 0;
}

module.exports = { resolveProviderForProduct, extractEndpointId, computeUsageCost, applyAllowedOverrides };
