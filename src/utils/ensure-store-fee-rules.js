const StoreFeeRule = require('../models/StoreFeeRule');
const {
  GOOGLE_PLAY_STORE_FEE_RATE,
  APP_STORE_STORE_FEE_RATE,
} = require('../finance/constants');

const DEFAULTS = [
  {
    name: 'Default Google Play (CHPlay) service fee',
    salesChannel: 'GOOGLE_PLAY',
    rate: GOOGLE_PLAY_STORE_FEE_RATE,
    collector: 'GOOGLE',
    notes: 'Google Play service fee on IAP. Actual Google terms may be 15% or 30%.',
  },
  {
    name: 'Default App Store commission',
    salesChannel: 'APP_STORE',
    rate: APP_STORE_STORE_FEE_RATE,
    collector: 'APPLE',
    notes: 'Apple commission on IAP. Small Business / year-2 subscription may be 15%.',
  },
];

async function ensureStoreFeeRules() {
  const created = [];
  for (const row of DEFAULTS) {
    const existing = await StoreFeeRule.findOne({
      salesChannel: row.salesChannel,
      status: 'ACTIVE',
    });
    if (existing) continue;
    const doc = await StoreFeeRule.create({
      ...row,
      effectiveFrom: new Date('2026-09-07T00:00:00.000Z'),
      status: 'ACTIVE',
    });
    created.push({ channel: doc.salesChannel, rate: doc.rate, id: doc._id });
  }
  return { created: created.length, rules: created };
}

module.exports = { ensureStoreFeeRules };
