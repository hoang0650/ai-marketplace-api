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

const { toUsd, charCount, tokenUnitSize, charUnitSize, timeUnitSeconds, needsFx, assertConvertible } = require('./usage-pricing');
const {
  unitByCode,
  measureGatewayUsage,
  billMeasuredUsage,
  cachedTokenCount,
  isBillableUsage,
  ROUNDING_ID,
} = require('../finance/usage-units');

const round6 = (value) => Math.round(Number(value) * 1e6) / 1e6;
const { isUpstreamPriced, providerCostParts, sellPrice } = require('./runpod-public-pricing');

function listedRates(pricing = {}) {
  const rate = Number(pricing.usageRate);
  return {
    rate: Number.isFinite(rate) ? rate : 0,
    inputRate: pricing.inputRate == null || pricing.inputRate === '' ? null : Number(pricing.inputRate),
    outputRate: pricing.outputRate == null || pricing.outputRate === '' ? null : Number(pricing.outputRate),
    cachedInputRate: pricing.cachedInputRate == null || pricing.cachedInputRate === '' ? null : Number(pricing.cachedInputRate),
    currency: pricing.currency || 'USD',
  };
}

function applyMinCharge(costUsd, pricing = {}) {
  const cost = round6(costUsd);
  const min = toUsd(Number(pricing.minCharge) || 0, pricing.currency || 'USD');
  if (cost > 0 && min > 0 && cost < min) return round6(min);
  return cost;
}

function packCharge(pricing, costUsd, extra = {}) {
  const rates = listedRates(pricing);
  const amount = applyMinCharge(costUsd, pricing);
  const unit = extra.unit || pricing.usageUnit || null;
  const quantity = Number(extra.quantity) || 0;
  return {
    costUsd: amount,
    quantity,
    unit,
    ...rates,
    inputTokens: Number(extra.inputTokens) || 0,
    outputTokens: Number(extra.outputTokens) || 0,
    cachedTokens: Number(extra.cachedTokens) || 0,
    billableUnits: Number(extra.billableUnits) || 0,
    rounding: extra.rounding || null,
    estimated: Boolean(extra.estimated),
    sellerReported: Boolean(extra.sellerReported),
    measured: Boolean(extra.measured),
    unbilled: extra.unbilled || null,
    bill: {
      unit,
      quantity,
      rate: rates.rate,
      currency: rates.currency,
      inputRate: Number.isFinite(rates.inputRate) ? rates.inputRate : null,
      outputRate: Number.isFinite(rates.outputRate) ? rates.outputRate : null,
      cachedInputRate: Number.isFinite(rates.cachedInputRate) ? rates.cachedInputRate : null,
      amount,
      amountCurrency: 'USD',
      rounding: extra.rounding || null,
      billableUnits: Number(extra.billableUnits) || 0,
      estimated: Boolean(extra.estimated),
      sellerReported: Boolean(extra.sellerReported),
    },
  };
}

/**
 * USD charge plus the quantity, unit and rates written onto the buyer's usage row.
 *
 * When the seller has set `pricing.usageRate` we bill against it. Otherwise we
 * fall back to `providerCost` — the figure RunPod reports in `output.cost`
 * (or denglish-api's estimate from the model's documented pricing formula) —
 * so pay-per-use products stay in sync with the upstream price list.
 * `costUsd` is half-up to 6 decimal USD, then raised to `minCharge` when the
 * measured cost is above zero and below that floor.
 */
function explainUsageCharge(product, usage, input = {}, providerCost = 0) {
  const pricing = product?.pricing || {};
  const voice = isVoiceCategory(product?.category);
  if (pricing.model !== 'usage' && !voice) return packCharge(pricing, 0);
  if (usage?.sandbox) return packCharge(pricing, 0, { unbilled: 'sandbox' });
  if (!isBillableUsage(usage)) return packCharge(pricing, 0, { unbilled: 'http_status', measured: true });
  const currency = pricing.currency || 'USD';
  if (needsFx(currency)) {
    assertConvertible(currency, 1, pricing.usageRate, pricing.inputRate, pricing.outputRate, pricing.cachedInputRate, pricing.minCharge);
  }

  const parts = providerCostParts(providerCost);

  if (isUpstreamPriced(product)) {
    if (parts.upstream > 0) {
      return packCharge(pricing, sellPrice(parts.upstream, pricing.upstreamMarkup), { measured: true, unit: pricing.usageUnit || 'upstream' });
    }
    if (parts.cost > 0) return packCharge(pricing, round6(parts.cost), { measured: true, unit: pricing.usageUnit || 'upstream' });
    if (pricing.upstreamMarkup !== undefined) {
      const prompt = Number(usage.input_tokens) || 0;
      const output = Number(usage.output_tokens) || 0;
      const cached = Math.min(prompt, cachedTokenCount(usage));
      const fresh = prompt - cached;
      const cost = ((fresh * (pricing.inputRate || 0)) + cached * (pricing.cachedInputRate ?? pricing.inputRate ?? 0) + output * (pricing.outputRate || 0)) / 1000000;
      return packCharge(pricing, round6(cost), {
        measured: true,
        quantity: prompt + output,
        unit: pricing.usageUnit || '1m_tokens',
        inputTokens: fresh,
        outputTokens: output,
        cachedTokens: cached,
        rounding: ROUNDING_ID,
      });
    }
    const listed = toUsd(Number(pricing.usageRate) || 0, pricing.currency || 'USD');
    return packCharge(pricing, listed > 0 ? round6(listed) : 0, { measured: true, quantity: listed > 0 ? 1 : 0 });
  }

  const canonical = unitByCode(pricing.usageUnit);
  if (canonical) {
    if (canonical.kind === 'entitlement') return packCharge(pricing, 0, { unit: canonical.code, unbilled: 'entitlement' });
    const measurement = measureGatewayUsage({
      unit: canonical.code,
      category: product?.category,
      input,
      upstreamUsage: usage,
      output: usage?.output || input?.output || null,
      elapsedMs: usage?.elapsedMs,
    });
    const billed = billMeasuredUsage({
      unit: canonical.code,
      rate: pricing.usageRate,
      currency: pricing.currency || 'USD',
      inputRate: pricing.inputRate,
      outputRate: pricing.outputRate,
      cachedInputRate: pricing.cachedInputRate,
      measurement,
    });
    return packCharge(pricing, billed.costUsd, {
      measured: true,
      quantity: billed.quantity,
      unit: canonical.code,
      inputTokens: measurement.inputTokens,
      outputTokens: measurement.outputTokens,
      cachedTokens: measurement.cachedTokens,
      billableUnits: billed.billableUnits,
      rounding: billed.rounding,
      estimated: measurement.estimated,
      sellerReported: measurement.sellerReported,
      unbilled: measurement.unbilled || null,
    });
  }

  const productUnit = String(pricing.usageUnit || (voice ? 'characters' : 'tokens'));
  const unit = String(usage?.unit || productUnit);
  const rate = toUsd(Number(pricing.usageRate) || 0, currency);
  const inputRate = toUsd(Number(pricing.inputRate) || 0, currency);
  const outputRate = toUsd(Number(pricing.outputRate) || 0, currency);
  const cachedRate = pricing.cachedInputRate == null || pricing.cachedInputRate === ''
    ? null
    : toUsd(Number(pricing.cachedInputRate) || 0, currency);
  const quantity = Number(usage?.quantity);

  if (rate > 0 || inputRate > 0 || outputRate > 0 || cachedRate != null) {
    if (/char/i.test(unit) || voice) {
      const chars = Number.isFinite(quantity) && quantity > 0 ? quantity : charCount(input?.prompt || input?.text || '');
      if (!(chars > 0)) return packCharge(pricing, 0, { measured: true, unit: productUnit });
      const metaPer = Number(product?.contentMeta?.charactersPerCredit);
      const perCredit = Math.max(1, metaPer > 0 ? metaPer : charUnitSize(productUnit));
      const billableUnits = chars / perCredit;
      return packCharge(pricing, round6(billableUnits * rate), {
        measured: true,
        quantity: chars,
        unit: productUnit,
        billableUnits,
        rounding: ROUNDING_ID,
      });
    }
    if (unit === 'seconds' || unit === 'images' || unit === 'requests') {
      let qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
      if (!qty) qty = unit === 'seconds' ? Number(input?.duration) || 0 : 1;
      const raw = qty;
      if (unit === 'seconds') {
        const per = timeUnitSeconds(productUnit);
        if (per && per !== 1) qty /= per;
      }
      return packCharge(pricing, round6(qty * rate), {
        measured: true,
        quantity: raw,
        unit: productUnit,
        billableUnits: qty,
        rounding: ROUNDING_ID,
      });
    }
    const size = tokenUnitSize(productUnit);
    const prompt = Number(usage?.input_tokens ?? usage?.prompt_tokens) || 0;
    const outTok = Number(usage?.output_tokens ?? usage?.completion_tokens) || 0;
    const cached = Math.min(prompt, cachedTokenCount(usage || {}));
    const inTok = prompt - cached;
    const totalTokens = Number(usage?.total_tokens) || prompt + outTok;
    if (inputRate > 0 || outputRate > 0 || cachedRate != null) {
      const inR = inputRate > 0 ? inputRate : rate;
      const outR = outputRate > 0 ? outputRate : rate;
      const cacheR = cachedRate != null ? cachedRate : inR;
      const split = prompt || outTok
        ? inTok * inR + cached * cacheR + outTok * outR
        : totalTokens * Math.max(inR, outR);
      const cost = split / size;
      return packCharge(pricing, round6(cost), {
        measured: true,
        quantity: prompt || outTok ? prompt + outTok : totalTokens,
        unit: productUnit,
        inputTokens: inTok,
        outputTokens: outTok,
        cachedTokens: cached,
        billableUnits: cost / (rate || inR || outR || 1),
        rounding: ROUNDING_ID,
      });
    }
    const billableUnits = totalTokens / size;
    return packCharge(pricing, round6(billableUnits * rate), {
      measured: true,
      quantity: totalTokens,
      unit: productUnit,
      inputTokens: inTok,
      outputTokens: outTok,
      cachedTokens: cached,
      billableUnits,
      rounding: ROUNDING_ID,
    });
  }

  const upstream = parts.cost;
  const cost = Number.isFinite(upstream) && upstream > 0 ? round6(upstream) : 0;
  return packCharge(pricing, cost, { measured: true });
}

function computeUsageCost(product, usage, input = {}, providerCost = 0) {
  return explainUsageCharge(product, usage, input, providerCost).costUsd;
}

module.exports = {
  resolveProviderForProduct,
  extractEndpointId,
  computeUsageCost,
  explainUsageCharge,
  applyAllowedOverrides,
};
