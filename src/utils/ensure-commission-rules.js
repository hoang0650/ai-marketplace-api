const CommissionRule = require('../models/CommissionRule');
const { PLATFORM_COMMISSION_RATE } = require('../finance/constants');

async function ensureCommissionRules() {
  const existing = await CommissionRule.findOne({
    name: 'Default Marketplace Commission',
    appliesTo: 'THIRD_PARTY_SELLER',
    status: 'ACTIVE',
  });
  if (existing) return { created: false, rate: existing.rate };

  const doc = await CommissionRule.create({
    name: 'Default Marketplace Commission',
    rate: PLATFORM_COMMISSION_RATE,
    appliesTo: 'THIRD_PARTY_SELLER',
    categories: [],
    sellerTypes: [],
    effectiveFrom: new Date('2026-09-06T00:00:00.000Z'),
    status: 'ACTIVE',
  });
  return { created: true, rate: doc.rate, id: doc._id };
}

module.exports = { ensureCommissionRules };
