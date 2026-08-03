/** Platform take-rate on marketplace GMV (paid orders). */
const PLATFORM_FEE_RATE = 0.2;

function splitRevenue(gross) {
  const g = Number(gross) || 0;
  const platformFee = Math.round(g * PLATFORM_FEE_RATE * 100) / 100;
  const sellerNet = Math.round((g - platformFee) * 100) / 100;
  return { gross: g, platformFee, sellerNet };
}

module.exports = { PLATFORM_FEE_RATE, splitRevenue };
