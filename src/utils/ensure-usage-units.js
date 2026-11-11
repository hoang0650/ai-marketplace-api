const Product = require('../models/Product');
const { applyUsageUnitMigration } = require('../finance/usage-units');

/**
 * Idempotent startup backfill. Unambiguous free-text usage units become enum
 * codes. The rest are flagged needs_review and keep their original text.
 * A second boot changes nothing.
 */
async function ensureUsageUnits({ log = console.log } = {}) {
  const rows = await Product.find({ 'pricing.model': 'usage' })
    .select('category pricing contentMeta.charactersPerCredit')
    .limit(5000);
  let canonical = 0;
  let review = 0;
  let unchanged = 0;
  for (const row of rows) {
    const result = applyUsageUnitMigration(row);
    if (!result.changed) {
      unchanged += 1;
      continue;
    }
    row.markModified('pricing');
    await row.save();
    if (result.status === 'canonical') canonical += 1;
    else review += 1;
  }
  log(`[catalog] usage units canonical=${canonical} review=${review} unchanged=${unchanged}`);
  return { canonical, review, unchanged };
}

module.exports = { ensureUsageUnits };
