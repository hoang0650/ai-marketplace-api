/**
 * Public Endpoints catalog — buyer-facing URLs are api.aimarkets.vn / aimarkets.vn.
 * Source JSON kept in sync with ai-marketplace/src/assets/runpod-public-endpoints.json
 * Internal RunPod routing uses `endpointId` (never the public URLs).
 */
const catalog = require('./runpod-public-endpoints.json');
const { publicCatalogUrls } = require('../utils/gateway-urls');
const { sellPrice, sellPricingText } = require('../utils/runpod-public-pricing');

/** Public view: our sell prices only; the provider's base price never leaves the API. */
function withPublicUrls(entry) {
  const urls = publicCatalogUrls(entry.slug, { openai: !!entry.openaiModel });
  const { price, ...rest } = entry;
  return {
    ...rest,
    ...urls,
    pricing: sellPricingText(entry.pricing, entry.sellMarkup),
    price: price ? { rate: sellPrice(price.rate, entry.sellMarkup), unit: price.unit, currency: 'USD' } : undefined,
  };
}

function listRunpodPublicEndpoints({ kind, modality, q } = {}) {
  const query = (q || '').trim().toLowerCase();
  return catalog
    .filter((e) => !e.status || e.status === 'active')
    .filter((e) => {
      if (kind && e.kind !== kind) return false;
      if (modality && e.modality !== modality) return false;
      if (!query) return true;
      const hay = `${e.name} ${e.slug} ${e.endpointId} ${e.description} ${e.pricing}`.toLowerCase();
      return hay.includes(query);
    })
    .map(withPublicUrls);
}

function getRunpodPublicEndpoint(slugOrId) {
  const key = String(slugOrId || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:aim|runpod)-/, '');
  const hit =
    catalog.find(
      (e) =>
        e.slug === key ||
        e.endpointId === key ||
        e.runsyncUrl === slugOrId ||
        e.runUrl === slugOrId
    ) || null;
  return hit ? withPublicUrls(hit) : null;
}

module.exports = {
  RUNPOD_PUBLIC_ENDPOINTS: catalog.map(withPublicUrls),
  listRunpodPublicEndpoints,
  getRunpodPublicEndpoint,
};
