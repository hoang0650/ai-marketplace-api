const mongoose = require('mongoose');

/**
 * Last good provider snapshot plus an optional admin override.
 * One document (`key: 'current'`) is the cache; each wallet top-up also
 * copies the rate it used onto its own meta for audit.
 */
const exchangeRateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'current' },
    vndPerUsd: { type: Number, default: null },
    cnyPerUsd: { type: Number, default: null },
    providerUpdatedAt: { type: Date, default: null },
    fetchedAt: { type: Date, default: null },
    overrideVndPerUsd: { type: Number, default: null },
    overrideCnyPerUsd: { type: Number, default: null },
    overrideUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'exchange_rates' },
);

module.exports = mongoose.models.ExchangeRate || mongoose.model('ExchangeRate', exchangeRateSchema);
