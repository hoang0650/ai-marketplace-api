/** Pricing / free-trial policy for the GPU studio (pure; unit-tested). */
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

function studioPolicy(env = process.env) {
  return {
    fast: { freePerDay: num(env.STUDIO_FREE_FAST_PER_DAY, 5), price: num(env.STUDIO_PRICE_FAST_USD, 0.05) },
    talking: { freePerDay: num(env.STUDIO_FREE_TALKING_PER_DAY, 3), price: num(env.STUDIO_PRICE_TALKING_USD, 0.1) },
    tts: { freePerDay: num(env.STUDIO_FREE_TTS_PER_DAY, 30), price: num(env.STUDIO_PRICE_TTS_USD, 0.01) },
    promoPerDay: num(env.STUDIO_PROMO_PER_DAY, 20),
  };
}

/** Start of the current day in Asia/Ho_Chi_Minh (UTC+7), as a Date. */
function dayStart(now = new Date()) {
  const off = 7 * 3600e3;
  const local = new Date(now.getTime() + off);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - off);
}

/** Decide whether a job is free, charged, or rejected. */
function decide({ kind, usedToday, available, policy = studioPolicy(), promo = false }) {
  const p = policy[kind];
  if (!p) return { ok: false, status: 400, code: 'BAD_KIND' };
  if (promo) {
    // Launch promo: never charge; a larger daily cap still prevents abuse.
    const cap = Math.max(p.freePerDay, policy.promoPerDay || 0);
    if (usedToday >= cap) return { ok: false, status: 429, code: 'FREE_QUOTA_EXHAUSTED' };
    return { ok: true, free: true, charge: 0, remainingFree: cap - usedToday - 1, promo: true };
  }
  if (usedToday < p.freePerDay) return { ok: true, free: true, charge: 0, remainingFree: p.freePerDay - usedToday - 1 };
  if (!(p.price > 0)) return { ok: false, status: 429, code: 'FREE_QUOTA_EXHAUSTED' };
  if ((Number(available) || 0) + 1e-9 < p.price) {
    return { ok: false, status: 402, code: 'INSUFFICIENT_WALLET', price: p.price };
  }
  return { ok: true, free: false, charge: p.price, remainingFree: 0 };
}

module.exports = { studioPolicy, dayStart, decide };
