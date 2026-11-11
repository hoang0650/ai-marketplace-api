'use strict';

const { unitByCode, migrateUsageUnit } = require('./usage-units');
const { quoteAuthoritativeVnd } = require('./vnd-quote');

const PERIODS = [
  { key: 'day', unit: '1_day' },
  { key: 'week', unit: '1_week' },
  { key: 'month', unit: '1_month' },
  { key: 'year', unit: '1_year' },
];

const USAGE_INCLUDES = {
  vi: 'Trả theo lượng đã dùng. Đây không phải giá thuê theo ngày, tuần, tháng hay năm.',
  en: 'Charged for measured use. This is not a day, week, month or year pass.',
};

const PERIOD_INCLUDES = {
  vi: 'Dùng trong thời hạn này, không tính thêm theo ký tự hay token. Đây không phải đơn giá theo 1K ký tự.',
  en: 'Access for this period is not metered. This is not the per-1K-character rate.',
};

function promisesDayMonthYear(product) {
  const text = `${product?.description || ''}\n${product?.tagline || ''}`;
  return /ngày\s*\/\s*tháng\s*\/\s*năm|day\s*\/\s*month\s*\/\s*year/i.test(text);
}

function quote(amount, currency, fx) {
  return quoteAuthoritativeVnd({
    amount,
    currency,
    vndPerUsd: fx?.vndPerUsd,
    rateSource: fx?.rateSource,
  });
}

/**
 * One row per way to buy. A usage rate and a day/month/year pass are never
 * the same offer, so a screen cannot label the pass price as a per-character rate.
 * A promised period with no stored price is needs_review. No price is invented.
 */
function buildSellOffers(product = {}, fx = {}) {
  const pricing = product.pricing || {};
  const currency = pricing.currency || 'USD';
  const offers = [];

  if (pricing.model === 'usage' && Number(pricing.usageRate) > 0) {
    const migration = migrateUsageUnit(pricing.usageUnit, product.category, {
      charactersPerCredit: product.contentMeta?.charactersPerCredit,
    });
    const unit = migration.status === 'canonical' ? unitByCode(migration.code) : null;
    if (unit && unit.kind === 'metered') {
      offers.push({
        id: `usage_${unit.code}`,
        billingMode: 'usage',
        status: 'priced',
        unit: unit.code,
        labelVi: unit.labelVi,
        labelEn: unit.labelEn,
        rate: Number(pricing.usageRate),
        currency,
        rateVnd: quote(pricing.usageRate, currency, fx),
        price: null,
        priceVnd: null,
        includesVi: USAGE_INCLUDES.vi,
        includesEn: USAGE_INCLUDES.en,
      });
    }
  }

  const prices = product.contentMeta?.licensePrices || {};
  const promised = promisesDayMonthYear(product);
  for (const period of PERIODS) {
    const hasKey = Object.prototype.hasOwnProperty.call(prices, period.key);
    if (!hasKey && !(promised && period.key !== 'week')) continue;
    const unit = unitByCode(period.unit);
    const raw = Number(prices[period.key]);
    const known = hasKey && Number.isFinite(raw) && raw > 0;
    offers.push({
      id: `period_${period.unit}`,
      billingMode: 'period',
      status: known ? 'priced' : 'needs_review',
      unit: period.unit,
      labelVi: unit.labelVi,
      labelEn: unit.labelEn,
      rate: null,
      rateVnd: null,
      price: known ? raw : null,
      currency,
      priceVnd: known ? quote(raw, currency, fx) : null,
      includesVi: PERIOD_INCLUDES.vi,
      includesEn: PERIOD_INCLUDES.en,
    });
  }

  const card = offers.find((offer) => offer.billingMode === 'usage' && offer.status === 'priced')
    || offers.find((offer) => offer.status === 'priced')
    || null;
  return { offers, listOfferId: card ? card.id : null };
}

module.exports = { buildSellOffers };
