const { roundMoney } = require('./constants');
const { normalizeSellerType } = require('./seller-types');
const { taxConfig } = require('../config/tax');

/** Seller types whose tax the platform withholds and pays on their behalf (NĐ 252/2026/NĐ-CP). */
const WITHHELD_SELLER_TYPES = new Set(['INDIVIDUAL', 'FOREIGN_INDIVIDUAL']);
/** Seller types that issue their own invoices / self-declare: no platform withholding. */
const SELF_DECLARING_SELLER_TYPES = new Set(['HOUSEHOLD_BUSINESS', 'COMPANY', 'FOREIGN_COMPANY']);

const PHYSICAL_TAX_CATEGORIES = new Set(['PHYSICAL_GOODS']);

/** 'GOODS' for physical goods, 'DIGITAL' (services/software/digital products) otherwise. */
function productTaxKind(taxCategory) {
  return PHYSICAL_TAX_CATEGORIES.has(String(taxCategory || '').toUpperCase()) ? 'GOODS' : 'DIGITAL';
}

function toVnd(amount, currency, cfg) {
  return String(currency || 'USD').toUpperCase() === 'VND' ? Number(amount) || 0 : (Number(amount) || 0) * cfg.vndPerUsd;
}

/**
 * Type-based seller tax for one order (pure). Base = price after discount (order gross).
 * `sellerAnnualRevenueVnd` = the seller's revenue earlier in the same calendar year (VND); when
 * unknown (undefined/null) the threshold exemption is not applied (withhold - conservative).
 * Returns the TaxEngine result shape plus a `policy` snapshot stored on the order.
 */
function calculateSellerTax({
  sellerType: rawType,
  taxCategory,
  grossAmount,
  currency = 'USD',
  sellerAnnualRevenueVnd,
  digits = 2,
  config,
} = {}) {
  const cfg = config || taxConfig();
  const sellerType = normalizeSellerType(rawType);
  const base = roundMoney(Math.max(0, Number(grossAmount) || 0), digits);
  const kind = productTaxKind(taxCategory);
  const policy = {
    version: '2026-10',
    sellerType,
    productKind: kind,
    taxBase: base,
    vatRate: 0,
    pitRate: 0,
    rate: 0,
    vatAmount: 0,
    pitAmount: 0,
    withheldByPlatform: false,
    annualThresholdVnd: cfg.individual.annualThresholdVnd,
    sellerAnnualRevenueVnd: sellerAnnualRevenueVnd ?? null,
    rule: '',
    legalBasis: '',
  };
  const empty = (reason) => ({
    taxApplicable: false,
    taxes: [],
    totalTaxAmount: 0,
    withholdingRequired: false,
    reason,
    policy: { ...policy, rule: reason },
  });

  if (sellerType === 'PLATFORM') return empty('PLATFORM_SALE_USES_OPERATOR_ACCOUNTING');
  if (SELF_DECLARING_SELLER_TYPES.has(sellerType)) {
    return empty(sellerType === 'HOUSEHOLD_BUSINESS' ? 'HKD_SELF_DECLARES_NO_WITHHOLDING' : 'COMPANY_SELF_DECLARES_NO_WITHHOLDING');
  }
  if (!WITHHELD_SELLER_TYPES.has(sellerType)) return empty('NO_WITHHOLDING_FOR_SELLER_TYPE');

  const threshold = cfg.individual.annualThresholdVnd;
  if (threshold > 0 && sellerAnnualRevenueVnd !== undefined && sellerAnnualRevenueVnd !== null) {
    const projected = (Number(sellerAnnualRevenueVnd) || 0) + toVnd(base, currency, cfg);
    if (projected <= threshold) return empty('INDIVIDUAL_BELOW_ANNUAL_THRESHOLD');
  }

  const rates = kind === 'GOODS' ? cfg.individual.goods : cfg.individual.digital;
  const vatAmount = roundMoney(base * rates.vat, digits);
  const pitAmount = roundMoney(base * rates.pit, digits);
  const rule = kind === 'GOODS' ? 'VN_INDIVIDUAL_GOODS_1_5PCT' : 'VN_INDIVIDUAL_DIGITAL_7PCT';
  const taxes = [];
  if (vatAmount > 0) taxes.push({ type: 'VAT', rate: rates.vat, amount: vatAmount, ruleId: null, name: `${rule}_GTGT` });
  if (pitAmount > 0) taxes.push({ type: 'PIT', rate: rates.pit, amount: pitAmount, ruleId: null, name: `${rule}_TNCN` });
  const total = roundMoney(vatAmount + pitAmount, digits);
  return {
    taxApplicable: total > 0,
    taxes,
    totalTaxAmount: total,
    withholdingRequired: total > 0,
    reason: rule,
    policy: {
      ...policy,
      vatRate: rates.vat,
      pitRate: rates.pit,
      rate: roundMoney(rates.vat + rates.pit, 6),
      vatAmount,
      pitAmount,
      withheldByPlatform: total > 0,
      rule,
      legalBasis: 'NĐ 252/2026/NĐ-CP; Luật Thuế TNCN; TT 18/2026/TT-BTC',
    },
  };
}

/** Rates surfaced to dashboards / legal pages (no order needed). */
function sellerTaxRateFor(sellerType, taxCategory, config) {
  const cfg = config || taxConfig();
  const t = normalizeSellerType(sellerType);
  if (!WITHHELD_SELLER_TYPES.has(t)) return { vat: 0, pit: 0, total: 0, withheldByPlatform: false };
  const r = productTaxKind(taxCategory) === 'GOODS' ? cfg.individual.goods : cfg.individual.digital;
  return { vat: r.vat, pit: r.pit, total: roundMoney(r.vat + r.pit, 6), withheldByPlatform: true };
}

/** Public summary of the policy (seller dashboards, legal pages, apps). */
function publicTaxPolicy(config) {
  const cfg = config || taxConfig();
  const d = cfg.individual.digital;
  const g = cfg.individual.goods;
  return {
    version: '2026-10',
    platformFeeRate: 0.2,
    platformFeeVatRate: cfg.platformFeeVatRate,
    individual: {
      withheldByPlatform: true,
      digital: { vat: d.vat, pit: d.pit, total: roundMoney(d.vat + d.pit, 6) },
      goods: { vat: g.vat, pit: g.pit, total: roundMoney(g.vat + g.pit, 6) },
      annualThresholdVnd: cfg.individual.annualThresholdVnd,
    },
    householdBusiness: { withheldByPlatform: false, rate: 0 },
    company: { withheldByPlatform: false, rate: 0, platformIssuesVatInvoiceOnFee: true },
    legalBasis: ['Nghị định 252/2026/NĐ-CP', 'Luật Thuế TNCN', 'Thông tư 18/2026/TT-BTC'],
    legalReview: true,
  };
}

module.exports = {
  WITHHELD_SELLER_TYPES,
  SELF_DECLARING_SELLER_TYPES,
  productTaxKind,
  calculateSellerTax,
  sellerTaxRateFor,
  publicTaxPolicy,
};
