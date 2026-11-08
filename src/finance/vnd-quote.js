const { convertAmount } = require('./bank-topup-core');

/**
 * Integer VND from the server rate. A client-supplied rate is not an input.
 * Fallback rates are not authoritative. USD ledger amounts are not relabelled:
 * the quote is a separate field and the charge stays in the stored currency.
 */
function quoteAuthoritativeVnd({ amount, currency = 'USD', vndPerUsd, rateSource } = {}) {
  const ledgerCurrency = String(currency || 'USD').toUpperCase();
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) {
    return { amountVnd: null, authoritative: false, code: 'AMOUNT_INVALID', ledgerCurrency, displayOnly: true };
  }
  if (ledgerCurrency === 'VND') {
    if (!Number.isSafeInteger(n)) {
      return { amountVnd: null, authoritative: false, code: 'VND_NOT_INTEGER', ledgerCurrency, displayOnly: true };
    }
    return { amountVnd: n, authoritative: true, code: null, ledgerCurrency, rateSource: null, displayOnly: false };
  }
  if (ledgerCurrency !== 'USD') {
    return { amountVnd: null, authoritative: false, code: 'CURRENCY_UNSUPPORTED', ledgerCurrency, displayOnly: true };
  }
  const rate = Number(vndPerUsd);
  if (!(rate > 0) || !rateSource || rateSource === 'fallback') {
    return { amountVnd: null, authoritative: false, code: 'RATE_UNAVAILABLE', ledgerCurrency, rateSource: rateSource || null, displayOnly: true };
  }
  const conv = convertAmount({ amount: n, currency: 'USD' }, rate);
  if (!conv || !Number.isSafeInteger(conv.amountVnd)) {
    return { amountVnd: null, authoritative: false, code: 'AMOUNT_BELOW_VND_PRECISION', ledgerCurrency, rateSource, displayOnly: true };
  }
  return {
    amountVnd: conv.amountVnd,
    authoritative: true,
    code: null,
    ledgerCurrency: 'USD',
    vndPerUsd: rate,
    rateSource,
    displayOnly: true,
  };
}

function assertClientVndMatches({ clientAmountVnd, serverQuote } = {}) {
  if (clientAmountVnd == null || clientAmountVnd === '') return { ok: true };
  if (!serverQuote?.authoritative || !Number.isSafeInteger(serverQuote.amountVnd)) {
    return { ok: false, code: serverQuote?.code || 'RATE_UNAVAILABLE' };
  }
  const sent = Number(clientAmountVnd);
  if (!Number.isSafeInteger(sent) || sent !== serverQuote.amountVnd) {
    return { ok: false, code: 'VND_PRICE_MISMATCH', amountVnd: serverQuote.amountVnd };
  }
  return { ok: true, amountVnd: serverQuote.amountVnd };
}

function pricingVnd(pricing = {}, fx = {}) {
  const currency = pricing.currency || 'USD';
  const one = (amount) => quoteAuthoritativeVnd({ amount, currency, vndPerUsd: fx.vndPerUsd, rateSource: fx.rateSource });
  return {
    ledgerCurrency: currency,
    clientRateIgnored: true,
    price: one(pricing.price),
    compareAtPrice: Number(pricing.compareAtPrice) > 0 ? one(pricing.compareAtPrice) : null,
    usageRate: Number(pricing.usageRate) > 0 ? one(pricing.usageRate) : null,
  };
}

async function currentFx() {
  try {
    const fx = await require('./exchange-rate').getExchangeRates();
    return { vndPerUsd: Number(fx?.vndPerUsd) || null, rateSource: fx?.source || null };
  } catch {
    return { vndPerUsd: null, rateSource: null };
  }
}

function stampMappedProduct(mapped, fx) {
  if (!mapped || typeof mapped !== 'object') return mapped;
  return { ...mapped, pricingVnd: pricingVnd(mapped.pricing || {}, fx || {}) };
}

module.exports = {
  quoteAuthoritativeVnd,
  assertClientVndMatches,
  pricingVnd,
  currentFx,
  stampMappedProduct,
};
