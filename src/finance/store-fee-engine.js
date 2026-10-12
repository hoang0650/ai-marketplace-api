
const SALES_CHANNELS = {
  WEB: 'WEB',
  GOOGLE_PLAY: 'GOOGLE_PLAY',
  APP_STORE: 'APP_STORE',
};

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

/**
 * Orders are always paid from the AI Markets wallet; Apple IAP / Google Play Billing are used
 * only to top up the wallet (Quy chế 2.1). No store fee is ever deducted from an order or from
 * the seller payable. Kept for the settlement contract: always 0. Historical orders keep the
 * store-fee snapshot they were settled with; StoreFeeRule documents are ignored (not deleted).
 */
function defaultStoreFeeRate() {
  return 0;
}

function calculateStoreFee({ salesChannel } = {}) {
  return {
    channel: normalizeSalesChannel(salesChannel),
    rate: 0,
    amount: 0,
    borneBy: 'SELLER',
    collector: '',
    ruleId: null,
    ruleName: 'NO_STORE_FEE',
  };
}

module.exports = {
  SALES_CHANNELS,
  normalizeSalesChannel,
  defaultStoreFeeRate,
  calculateStoreFee,
};
