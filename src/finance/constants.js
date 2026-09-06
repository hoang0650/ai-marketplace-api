const PLATFORM_COMMISSION_RATE = 0.2;

/** @deprecated Alias — use PLATFORM_COMMISSION_RATE. Not a tax rate. */
const PLATFORM_FEE_RATE = PLATFORM_COMMISSION_RATE;

function roundMoney(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(n) || 0) * f) / f;
}

module.exports = {
  PLATFORM_COMMISSION_RATE,
  PLATFORM_FEE_RATE,
  roundMoney,
};
