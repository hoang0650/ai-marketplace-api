const { PLATFORM_COMMISSION_RATE, roundMoney } = require('./constants');

function inRange(rule, date) {
  const t = date ? new Date(date).getTime() : Date.now();
  if (rule.effectiveFrom && t < new Date(rule.effectiveFrom).getTime()) return false;
  if (rule.effectiveTo && t > new Date(rule.effectiveTo).getTime()) return false;
  return true;
}

function ruleScore(rule, ctx) {
  let score = 0;
  if (rule.sellerId && String(rule.sellerId) === String(ctx.sellerId)) score += 100;
  else if (rule.sellerId) return -1;
  if (rule.categories?.length) {
    if (rule.categories.includes(ctx.category) || rule.categories.includes(ctx.taxCategory)) score += 40;
    else return -1;
  }
  if (rule.sellerTypes?.length) {
    if (rule.sellerTypes.includes(ctx.sellerType)) score += 20;
    else return -1;
  }
  if (rule.appliesTo === 'THIRD_PARTY_SELLER' || !rule.appliesTo) score += 1;
  return score;
}

/**
 * Pure CommissionEngine. Default 20% for third-party; 0% for platform-owned.
 * Controllers must not hard-code the rate — pass rules from commission_rules.
 */
function calculateCommission({
  ownershipType = 'THIRD_PARTY_SELLER',
  sellerId,
  sellerType,
  category,
  taxCategory,
  grossAmount,
  transactionDate = new Date(),
  rules = [],
  digits = 2,
} = {}) {
  const baseAmount = roundMoney(grossAmount, digits);

  if (ownershipType === 'PLATFORM_DIRECT' || sellerType === 'PLATFORM') {
    return {
      rate: 0,
      baseAmount,
      commissionAmount: 0,
      currency: undefined,
      ruleId: null,
      ruleName: 'PLATFORM_DIRECT_NO_MARKETPLACE_COMMISSION',
      appliesTo: 'PLATFORM',
    };
  }

  const active = (rules || []).filter(
    (r) => (r.status || 'ACTIVE') === 'ACTIVE' && inRange(r, transactionDate) && r.appliesTo !== 'PLATFORM',
  );
  let best = null;
  let bestScore = -1;
  for (const rule of active) {
    const s = ruleScore(rule, { sellerId, sellerType, category, taxCategory });
    if (s > bestScore) {
      bestScore = s;
      best = rule;
    }
  }

  const rate = best && Number.isFinite(Number(best.rate)) ? Number(best.rate) : PLATFORM_COMMISSION_RATE;
  const commissionAmount = roundMoney(baseAmount * rate, digits);

  return {
    rate,
    baseAmount,
    commissionAmount,
    currency: best?.currency,
    ruleId: best?._id || best?.id || null,
    ruleName: best?.name || 'DEFAULT_MARKETPLACE_COMMISSION',
    appliesTo: 'THIRD_PARTY_SELLER',
  };
}

module.exports = { calculateCommission };
