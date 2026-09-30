/** Catalog endpoint products are listed as `aim-<model>`; `runpod-<model>` is the legacy alias. */
const CATALOG_PREFIX = 'aim-';
const LEGACY_PREFIX = 'runpod-';
const PREFIX_RE = /^(?:aim|runpod)-/;

function catalogProductSlug(modelSlug) {
  return `${CATALOG_PREFIX}${modelSlug}`;
}

/** Old links and stored keys keep working: `runpod-x` resolves to `aim-x`. */
function canonicalProductSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  return s.startsWith(LEGACY_PREFIX) ? CATALOG_PREFIX + s.slice(LEGACY_PREFIX.length) : s;
}

/** Mongo filter matching the canonical slug first, then the raw one (seller slugs are never rewritten). */
function productSlugQuery(slug) {
  const raw = String(slug || '').trim().toLowerCase();
  const canonical = canonicalProductSlug(raw);
  return canonical === raw ? { slug: raw } : { slug: { $in: [canonical, raw] } };
}

function catalogModelSlug(slug) {
  return String(slug || '').replace(PREFIX_RE, '');
}

function isCatalogProductSlug(slug) {
  return PREFIX_RE.test(String(slug || ''));
}

module.exports = {
  CATALOG_PREFIX,
  LEGACY_PREFIX,
  catalogProductSlug,
  canonicalProductSlug,
  productSlugQuery,
  catalogModelSlug,
  isCatalogProductSlug,
};
