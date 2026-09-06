const { roundMoney } = require('./constants');
const { normalizeSellerType } = require('./seller-types');

function inRange(rule, date) {
  const t = date ? new Date(date).getTime() : Date.now();
  if (rule.effectiveFrom && t < new Date(rule.effectiveFrom).getTime()) return false;
  if (rule.effectiveTo && t > new Date(rule.effectiveTo).getTime()) return false;
  return true;
}

function matches(rule, ctx) {
  if ((rule.status || 'ACTIVE') !== 'ACTIVE') return false;
  if (!inRange(rule, ctx.transactionDate)) return false;
  if (rule.sellerTypes?.length && !rule.sellerTypes.includes(ctx.sellerType)) return false;
  if (rule.sellerCountries?.length && !rule.sellerCountries.includes(ctx.sellerCountry)) return false;
  if (rule.buyerCountries?.length && ctx.buyerCountry && !rule.buyerCountries.includes(ctx.buyerCountry)) {
    return false;
  }
  if (rule.taxCategories?.length && !rule.taxCategories.includes(ctx.taxCategory)) return false;
  if (rule.jurisdictions?.length && ctx.jurisdiction && !rule.jurisdictions.includes(ctx.jurisdiction)) {
    return false;
  }
  return true;
}

/**
 * Pure TaxEngine. Rates come only from TaxRule documents — never from controllers.
 * No matching ACTIVE rule → taxApplicable false, amount 0 (do not invent statutory rates).
 */
function calculateTax({
  seller,
  buyer,
  product,
  jurisdiction,
  transactionDate = new Date(),
  taxCategory,
  taxableAmount,
  rules = [],
  sellerTaxProfile = null,
  digits = 2,
} = {}) {
  const sellerType = normalizeSellerType(
    sellerTaxProfile?.sellerType || seller?.sellerType || seller?.type,
  );
  const sellerCountry = String(
    sellerTaxProfile?.country || seller?.country || jurisdiction || '',
  ).toUpperCase();
  const buyerCountry = String(buyer?.country || '').toUpperCase();
  const cat = taxCategory || product?.taxCategory || 'OTHER';
  const base = roundMoney(taxableAmount, digits);

  if (sellerType === 'PLATFORM') {
    return {
      taxApplicable: false,
      taxes: [],
      totalTaxAmount: 0,
      withholdingRequired: false,
      reason: 'PLATFORM_SALE_USES_OPERATOR_ACCOUNTING',
    };
  }

  const withholdingRequired = !!(sellerTaxProfile?.withholdingRequired);
  const matched = (rules || []).filter((rule) =>
    matches(rule, {
      sellerType,
      sellerCountry,
      buyerCountry,
      taxCategory: cat,
      jurisdiction: jurisdiction || sellerCountry,
      transactionDate,
    }),
  );

  if (!matched.length) {
    return {
      taxApplicable: false,
      taxes: [],
      totalTaxAmount: 0,
      withholdingRequired,
      reason: 'NO_MATCHING_TAX_RULE',
    };
  }

  const taxes = matched.map((rule) => {
    const rate = Number(rule.rate) || 0;
    const amount = roundMoney(base * rate, digits);
    return {
      type: rule.taxType || 'OTHER',
      rate,
      amount,
      ruleId: rule._id || rule.id || null,
      name: rule.name || rule.taxType || 'TAX',
    };
  });
  const totalTaxAmount = roundMoney(
    taxes.reduce((s, t) => s + t.amount, 0),
    digits,
  );

  return {
    taxApplicable: totalTaxAmount > 0 || matched.length > 0,
    taxes,
    totalTaxAmount,
    withholdingRequired: withholdingRequired || matched.some((r) => r.withholding !== false),
    reason: 'RULE_MATCH',
  };
}

module.exports = { calculateTax };
