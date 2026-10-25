'use strict';

/**
 * Sell prices for platform-owned public-endpoint products.
 *
 * Buyer price = upstream (provider) price × (1 + markup). The markup comes from
 * RUNPOD_PUBLIC_MARKUP and defaults to the GPU rental markup (GPU_RENTAL_MARKUP,
 * 0.30) so both platform-direct compute products earn the same margin.
 */
const { gpuRentalConfig } = require('./gpu-rental/config');

const COST_BASIS = 'upstream';

function runpodPublicMarkup() {
  const raw = process.env.RUNPOD_PUBLIC_MARKUP;
  const v = Number(raw);
  if (raw !== undefined && raw !== '' && Number.isFinite(v) && v >= 0) return v;
  return gpuRentalConfig().markup;
}

const round6 = (value) => Math.round(Number(value) * 1e6) / 1e6;

function sellPrice(upstream, markup = runpodPublicMarkup()) {
  const n = Number(upstream);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return round6(n * (1 + markup));
}

/** Short money string: up to 4 significant decimals, trailing zeros trimmed. */
function formatUsd(value) {
  const n = Number(value);
  if (!(n > 0)) return '$0';
  const digits = n >= 1 ? 2 : Math.min(6, Math.max(2, 1 - Math.floor(Math.log10(n)) + 2));
  let s = n.toFixed(digits);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  const [i, f = ''] = s.split('.');
  return `$${i}${f ? `.${f.padEnd(2, '0')}` : '.00'}`;
}

/** Rewrite every `$x` in an upstream price description to the marked-up sell price. */
function sellPricingText(text, markup = runpodPublicMarkup()) {
  return String(text || '').replace(/\$([0-9]+(?:\.[0-9]+)?)/g, (_, n) => formatUsd(sellPrice(n, markup)));
}

function isUpstreamPriced(product) {
  return String(product?.pricing?.costBasis || '') === COST_BASIS;
}

/**
 * Normalize what callers know about the provider price into `{ upstream, cost }`:
 * `upstream` is what the provider charges us, `cost` a ready-made sell price.
 */
function providerCostParts(providerCost) {
  if (providerCost && typeof providerCost === 'object') {
    return {
      upstream: Number(providerCost.upstream) || 0,
      cost: Number(providerCost.cost) || 0,
    };
  }
  return { upstream: 0, cost: Number(providerCost) || 0 };
}

module.exports = {
  COST_BASIS,
  runpodPublicMarkup,
  sellPrice,
  sellPricingText,
  formatUsd,
  isUpstreamPriced,
  providerCostParts,
};
