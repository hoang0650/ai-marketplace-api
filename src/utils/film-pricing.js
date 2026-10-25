/**
 * AI Film pricing (pure; unit-tested). RunPod list cost × (1 + markup):
 *   Wan 2.2 I2V 720p: $0.06 per generated second; Qwen-Image-Edit-2511: $0.02 per image.
 * No free daily quota: every generated second / image is billed, failed ones are refunded.
 */
const num = (v, d) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/** The RunPod endpoint only accepts 5 or 8 s clips (its docs also list 10/15 s, but the live API rejects them). */
const WAN_DURATIONS = [8, 5];
const SCENE_MAX_SEC = 60;
const PROJECT_MAX_SEC = 120 * 60;

function filmPricing(env = process.env) {
  const markup = num(env.STUDIO_FILM_MARKUP, num(env.GPU_RENTAL_MARKUP, 0.32));
  const secCost = num(env.FILM_I2V_COST_PER_SEC, 0.06);
  const imgCost = num(env.FILM_IMAGE_COST, 0.02);
  return {
    markup,
    secCost,
    imgCost,
    perSecond: round6(secCost * (1 + markup)),
    perImage: round6(imgCost * (1 + markup)),
  };
}

/**
 * Scene seconds -> Wan shot lengths of 8 s / 5 s (mirrors film_pipeline.split_duration in ai-marketplace-ai):
 * fewest shots whose total is within -2..+1 s of the target (never above 60 s), closest total first, 8 s shots first.
 * 30 -> 8+8+8+5 = 29 s, 60 -> 8*6+5+5 = 58 s, 40 -> 8*5. Billing uses the real seconds.
 */
function splitDuration(total) {
  let t = Math.round((Number(total) || 0) / 5) * 5;
  t = Math.max(5, Math.min(SCENE_MAX_SEC, t || 5));
  for (let n = 1; n <= 20; n += 1) {
    let best = null;
    for (let a = n; a >= 0; a -= 1) {
      const sum = 8 * a + 5 * (n - a);
      if (sum < t - 2 || sum > Math.min(t + 1, SCENE_MAX_SEC)) continue;
      const score = Math.abs(sum - t) * 2 + (sum > t ? 1 : 0);
      if (!best || score < best.score) best = { a, score };
    }
    if (best) return [...Array(best.a).fill(8), ...Array(n - best.a).fill(5)];
  }
  return [5];
}

/** Price of generating `seconds` of video and `images` reference/keyframe images. */
function filmCharge({ seconds = 0, images = 0 }, p = filmPricing()) {
  return round6(Math.max(0, seconds) * p.perSecond + Math.max(0, images) * p.perImage);
}

/** Refund for a settled job: what was charged minus what was actually produced (never negative). */
function filmRefund({ charged = 0, okSeconds = 0, okImages = 0, rates }) {
  const p = rates || filmPricing();
  const used = round6(okSeconds * p.perSecond + okImages * p.perImage);
  return round6(Math.max(0, Number(charged) - used));
}

module.exports = { filmPricing, splitDuration, filmCharge, filmRefund, round6, WAN_DURATIONS, SCENE_MAX_SEC, PROJECT_MAX_SEC };
