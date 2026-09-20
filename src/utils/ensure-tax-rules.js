const TaxRule = require('../models/TaxRule');
const { SELLER_TAX_RATE } = require('../finance/constants');

const DEFAULT_NAME = 'Default Seller Withholding Tax';

async function ensureTaxRules() {
  const existing = await TaxRule.findOne({ name: DEFAULT_NAME });
  if (existing) {
    let changed = false;
    if (existing.rate !== SELLER_TAX_RATE) {
      existing.rate = SELLER_TAX_RATE;
      changed = true;
    }
    if (existing.status !== 'ACTIVE') {
      existing.status = 'ACTIVE';
      changed = true;
    }
    if (existing.withholding !== true) {
      existing.withholding = true;
      changed = true;
    }
    if (changed) await existing.save();
    return { created: false, updated: changed, rate: existing.rate };
  }

  const doc = await TaxRule.create({
    name: DEFAULT_NAME,
    taxType: 'SELLER_WITHHOLDING',
    rate: SELLER_TAX_RATE,
    withholding: true,
    sellerTypes: [],
    sellerCountries: [],
    buyerCountries: [],
    taxCategories: [],
    jurisdictions: [],
    effectiveFrom: new Date('2026-09-20T00:00:00.000Z'),
    status: 'ACTIVE',
  });
  return { created: true, updated: false, rate: doc.rate, id: doc._id };
}

module.exports = { ensureTaxRules };
