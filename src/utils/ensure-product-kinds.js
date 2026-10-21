const Product = require('../models/Product');

/**
 * One-time-ish backfill: every product without a declared productKind becomes DIGITAL
 * (all current catalog categories are AI/digital services) and is stamped productKindDefaultedAt
 * so sellers/admins can review which rows were defaulted. Idempotent.
 */
async function ensureProductKinds({ log = console.log } = {}) {
  const filter = { $or: [{ productKind: { $exists: false } }, { productKind: '' }, { productKind: null }] };
  const rows = await Product.find(filter).select('slug creatorSlug category').limit(5000).lean();
  if (!rows.length) return { defaulted: 0, slugs: [] };
  const now = new Date();
  await Product.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { productKind: 'DIGITAL', productKindDefaultedAt: now } });
  const slugs = rows.map((r) => `${r.creatorSlug || '-'}/${r.slug}(${r.category})`);
  log(`[catalog] productKind defaulted to DIGITAL for ${rows.length} products: ${slugs.join(', ')}`);
  return { defaulted: rows.length, slugs };
}

module.exports = { ensureProductKinds };
