/**
 * Public Endpoints catalog — buyer-facing URLs are api.aimarkets.vn / aimarkets.vn.
 * Source JSON kept in sync with ai-marketplace/src/assets/runpod-public-endpoints.json
 * Internal RunPod routing uses `endpointId` (never the public URLs).
 */
const catalog = require('./runpod-public-endpoints.json');
const { publicCatalogUrls } = require('../utils/gateway-urls');

function withPublicUrls(entry) {
  const urls = publicCatalogUrls(entry.slug, { openai: !!entry.openaiModel });
  return { ...entry, ...urls };
}

function listRunpodPublicEndpoints({ kind, modality, q } = {}) {
  const query = (q || '').trim().toLowerCase();
  return catalog
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
    .replace(/^runpod-/, '');
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
