/**
 * RunPod Public Endpoints catalog — mirrored from docs.runpod.io/public-endpoints/reference
 * Source JSON kept in sync with ai-marketplace/src/assets/runpod-public-endpoints.json
 */
const catalog = require('./runpod-public-endpoints.json');

function listRunpodPublicEndpoints({ kind, modality, q } = {}) {
  const query = (q || '').trim().toLowerCase();
  return catalog.filter((e) => {
    if (kind && e.kind !== kind) return false;
    if (modality && e.modality !== modality) return false;
    if (!query) return true;
    const hay = `${e.name} ${e.slug} ${e.endpointId} ${e.description} ${e.pricing}`.toLowerCase();
    return hay.includes(query);
  });
}

function getRunpodPublicEndpoint(slugOrId) {
  const key = String(slugOrId || '').trim().toLowerCase();
  return (
    catalog.find(
      (e) =>
        e.slug === key ||
        e.endpointId === key ||
        e.runsyncUrl === slugOrId ||
        e.runUrl === slugOrId
    ) || null
  );
}

module.exports = {
  RUNPOD_PUBLIC_ENDPOINTS: catalog,
  listRunpodPublicEndpoints,
  getRunpodPublicEndpoint,
};
