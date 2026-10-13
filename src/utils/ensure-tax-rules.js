const TaxRule = require('../models/TaxRule');

/** Legacy flat rule (10% of the seller's 80% share = 8% of the order) - replaced by tax policy 2026-10. */
const LEGACY_DEFAULT_NAME = 'Default Seller Withholding Tax';

/**
 * Tax policy 2026-10 lives in code/env (finance/seller-tax-policy.js): individual 7% / 1.5%,
 * household business and company 0%. The legacy flat default rule would override it for every
 * seller, so it is switched to INACTIVE (kept for history - never deleted). No rule is seeded;
 * admins may still add ACTIVE TaxRules, which take precedence when they match.
 */
async function ensureTaxRules() {
  const existing = await TaxRule.findOne({ name: LEGACY_DEFAULT_NAME });
  if (existing && existing.status !== 'INACTIVE') {
    existing.status = 'INACTIVE';
    if (!existing.effectiveTo) existing.effectiveTo = new Date();
    await existing.save();
    return { legacyDeactivated: true };
  }
  return { legacyDeactivated: false };
}

module.exports = { ensureTaxRules, LEGACY_DEFAULT_NAME };
