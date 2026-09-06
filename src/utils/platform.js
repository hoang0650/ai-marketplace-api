/** Platform take-rate on third-party marketplace GMV (paid orders). */
const PLATFORM_FEE_RATE = 0.2;

function splitRevenue(gross, { ownershipType = 'THIRD_PARTY_SELLER' } = {}) {
  const g = Number(gross) || 0;
  if (ownershipType === 'PLATFORM_DIRECT') {
    return { gross: g, platformFee: Math.round(g * 100) / 100, sellerNet: 0 };
  }
  const platformFee = Math.round(g * PLATFORM_FEE_RATE * 100) / 100;
  const sellerNet = Math.round((g - platformFee) * 100) / 100;
  return { gross: g, platformFee, sellerNet };
}

module.exports = { PLATFORM_FEE_RATE, splitRevenue };
