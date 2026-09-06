const {
  roundMoney,
  GOOGLE_PLAY_STORE_FEE_RATE,
  APP_STORE_STORE_FEE_RATE,
} = require('./constants');

const SALES_CHANNELS = {
  WEB: 'WEB',
  GOOGLE_PLAY: 'GOOGLE_PLAY',
  APP_STORE: 'APP_STORE',
};

function inRange(rule, date) {
  const t = date ? new Date(date).getTime() : Date.now();
  if (rule.effectiveFrom && t < new Date(rule.effectiveFrom).getTime()) return false;
  if (rule.effectiveTo && t > new Date(rule.effectiveTo).getTime()) return false;
  return true;
}

/** CHPlay / Play Store / App Store aliases → canonical sales channel. Web/wallet → WEB (no store fee). */
function normalizeSalesChannel(raw) {
  const s = String(raw || 'WEB')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (['CHPLAY', 'CH_PLAY', 'PLAY_STORE', 'GOOGLEPLAY', 'GOOGLE_PLAY', 'PLAY', 'ANDROID'].includes(s)) {
    return SALES_CHANNELS.GOOGLE_PLAY;
  }
  if (['APPSTORE', 'APP_STORE', 'IOS', 'APPLE', 'APPLE_APP_STORE', 'IPHONE', 'IPAD'].includes(s)) {
    return SALES_CHANNELS.APP_STORE;
  }
  return SALES_CHANNELS.WEB;
}

function defaultStoreFeeRate(channel) {
  if (channel === SALES_CHANNELS.GOOGLE_PLAY) return GOOGLE_PLAY_STORE_FEE_RATE;
  if (channel === SALES_CHANNELS.APP_STORE) return APP_STORE_STORE_FEE_RATE;
  return 0;
}

function storeCollector(channel) {
  if (channel === SALES_CHANNELS.GOOGLE_PLAY) return 'GOOGLE';
  if (channel === SALES_CHANNELS.APP_STORE) return 'APPLE';
  return '';
}

/**
 * Store fee is charged by Google/Apple on IAP, not by AI Markets.
 * Deducted from seller payable (or from platform proceeds on PLATFORM_DIRECT).
 */
function calculateStoreFee({
  grossAmount,
  salesChannel,
  transactionDate = new Date(),
  rules = [],
  digits = 2,
} = {}) {
  const channel = normalizeSalesChannel(salesChannel);
  const base = roundMoney(grossAmount, digits);
  const active = (rules || []).find(
    (r) =>
      (r.status || 'ACTIVE') === 'ACTIVE' &&
      inRange(r, transactionDate) &&
      normalizeSalesChannel(r.salesChannel) === channel,
  );
  const rate =
    active && Number.isFinite(Number(active.rate)) ? Number(active.rate) : defaultStoreFeeRate(channel);
  const amount = roundMoney(base * rate, digits);
  return {
    channel,
    rate,
    amount,
    borneBy: 'SELLER',
    collector: storeCollector(channel),
    ruleId: active?._id || active?.id || null,
    ruleName: active?.name || (rate ? `DEFAULT_${channel}_STORE_FEE` : 'NO_STORE_FEE'),
  };
}

module.exports = {
  SALES_CHANNELS,
  normalizeSalesChannel,
  defaultStoreFeeRate,
  calculateStoreFee,
};
