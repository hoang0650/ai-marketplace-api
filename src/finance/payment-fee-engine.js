const { roundMoney } = require('./constants');

function inRange(rule, date) {
  const t = date ? new Date(date).getTime() : Date.now();
  if (rule.effectiveFrom && t < new Date(rule.effectiveFrom).getTime()) return false;
  if (rule.effectiveTo && t > new Date(rule.effectiveTo).getTime()) return false;
  return true;
}

/** Default: buyer pays listed price; payment fee 0 until a rule is configured. */
function calculatePaymentFee({
  grossAmount,
  ownershipType = 'THIRD_PARTY_SELLER',
  paymentMethod,
  transactionDate = new Date(),
  rules = [],
  digits = 2,
} = {}) {
  const base = roundMoney(grossAmount, digits);
  const active = (rules || []).find(
    (r) =>
      (r.status || 'ACTIVE') === 'ACTIVE' &&
      inRange(r, transactionDate) &&
      (!r.paymentMethods?.length || r.paymentMethods.includes(paymentMethod)) &&
      (!r.ownershipTypes?.length || r.ownershipTypes.includes(ownershipType)),
  );
  if (!active) {
    return { rate: 0, amount: 0, borneBy: 'SELLER', ruleId: null };
  }
  const rate = Number(active.rate) || 0;
  const amount = roundMoney(base * rate + (Number(active.fixedAmount) || 0), digits);
  return {
    rate,
    amount,
    borneBy: active.borneBy || 'SELLER',
    ruleId: active._id || active.id || null,
  };
}

module.exports = { calculatePaymentFee };
