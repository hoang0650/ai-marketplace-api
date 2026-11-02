/** Pricing / free-trial policy for the GPU studio (pure; unit-tested). */
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

function studioPolicy(env = process.env) {
  const ttsPerK = num(env.STUDIO_PRICE_TTS_PER_1K_CHARS_USD, num(env.STUDIO_PRICE_TTS_USD, 0.01));
  return {
    fast: { freePerDay: num(env.STUDIO_FREE_FAST_PER_DAY, 5), price: num(env.STUDIO_PRICE_FAST_USD, 0.05) },
    talking: { freePerDay: num(env.STUDIO_FREE_TALKING_PER_DAY, 3), price: num(env.STUDIO_PRICE_TALKING_USD, 0.1) },
    // TTS after the free daily jobs is billed per character (NFC code points): perKChars USD per 1,000 chars,
    // at least minCharge per job. `price` stays as the per-job figure for 1,000 characters (UI / legacy).
    tts: {
      freePerDay: num(env.STUDIO_FREE_TTS_PER_DAY, 10),
      promoCap: num(env.STUDIO_FREE_TTS_PER_DAY, 10),
      perKChars: ttsPerK,
      minCharge: num(env.STUDIO_PRICE_TTS_MIN_USD, 0.0005),
      price: ttsPerK,
      unit: '1K characters',
    },
    // A film is several heavy GPU jobs (one per scene), so it has its own, smaller promo cap.
    film: { freePerDay: num(env.STUDIO_FREE_FILM_PER_DAY, 1), price: num(env.STUDIO_PRICE_FILM_USD, 0.3), promoCap: num(env.STUDIO_PROMO_FILM_PER_DAY, 3) },
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

/** USD for `chars` billable characters of TTS: per-1K rate, minimum per job, rounded up to 1/10,000 USD. */
function ttsCharge(chars, p) {
  const n = Math.max(0, Math.floor(Number(chars) || 0));
  if (!(p.perKChars > 0) || n === 0) return 0;
  const raw = (n / 1000) * p.perKChars;
  return Math.max(p.minCharge || 0, Math.ceil(raw * 1e4 - 1e-9) / 1e4);
}

/** Decide whether a job is free, charged, or rejected. `chars` (TTS only) prices the job per character. */
function decide({ kind, usedToday, available, policy = studioPolicy(), promo = false, chars }) {
  const base = policy[kind];
  if (!base) return { ok: false, status: 400, code: 'BAD_KIND' };
  const p = kind === 'tts' && base.perKChars != null && chars != null ? { ...base, price: ttsCharge(chars, base) } : base;
  if (promo) {
    // Launch promo: never charge; a larger daily cap still prevents abuse.
    const cap = p.promoCap != null ? p.promoCap : Math.max(p.freePerDay, policy.promoPerDay || 0);
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

module.exports = { studioPolicy, dayStart, decide, ttsCharge };
