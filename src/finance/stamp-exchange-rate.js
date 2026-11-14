/**
 * Copy the rate actually used onto a new money record.
 * Later saves do not rewrite it, so a historical order stays reproducible.
 * A missing rate is left unset. Nothing here invents a figure.
 */
async function stampExchangeRate(doc) {
  if (!doc?.isNew) return;
  if (Number(doc.exchangeRate?.vndPerUsd) > 0) return;

  const locked = Number(doc.meta?.vndPerUsd);
  if (locked > 0) {
    doc.exchangeRate = {
      base: 'USD',
      vndPerUsd: locked,
      cnyPerUsd: Number(doc.meta?.cnyPerUsd) > 0 ? Number(doc.meta.cnyPerUsd) : null,
      source: doc.meta.exchangeRateSource || null,
      updatedAt: doc.meta.exchangeRateUpdatedAt || null,
      fetchedAt: doc.meta.exchangeRateFetchedAt || null,
    };
    return;
  }

  const orderId = doc.order || doc.orderId;
  if (orderId) {
    try {
      const Order = require('../models/Order');
      const order = await Order.findById(orderId).select('exchangeRate').lean();
      if (Number(order?.exchangeRate?.vndPerUsd) > 0) {
        doc.exchangeRate = order.exchangeRate;
        return;
      }
    } catch {
      /* fall through to the current quote */
    }
  }

  try {
    const { getExchangeRates, recordFromQuote } = require('./exchange-rate');
    const rec = recordFromQuote(await getExchangeRates());
    if (rec) doc.exchangeRate = rec;
  } catch (err) {
    console.warn('[exchange-rate] stamp skipped:', err?.message || err);
  }
}

const exchangeRateFields = {
  exchangeRate: {
    base: { type: String, default: '' },
    vndPerUsd: { type: Number, default: null },
    cnyPerUsd: { type: Number, default: null },
    source: { type: String, default: '' },
    updatedAt: { type: Date, default: null },
    fetchedAt: { type: Date, default: null },
  },
};

function attachExchangeRateStamp(schema) {
  schema.add(exchangeRateFields);
  schema.pre('save', function stampExchangeRateHook() {
    return stampExchangeRate(this);
  });
}

module.exports = { stampExchangeRate, attachExchangeRateStamp };
