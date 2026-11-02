const crypto = require('crypto');
const Quota = require('../models/FilmDailyQuota');
const { dayStart } = require('./studio-policy');
const { filmPricing, round6 } = require('./film-pricing');
function limits(env = process.env) {
  if (env.FILM_BACKEND !== 'own') return { videos: 0, images: 0, maxSeconds: 20 };
  const cap = (v, d) => Math.max(0, Math.floor(Number(v == null ? d : v) || 0));
  return { videos: cap(env.FILM_FREE_VIDEOS_PER_DAY, 0), images: cap(env.FILM_FREE_IMAGES_PER_DAY, 0), maxSeconds: 20 };
}
function allocation(usage, plan, env = process.env) {
  const cap = limits(env);
  return { videos: plan.seconds > 0 && plan.seconds <= cap.maxSeconds && usage.videos < cap.videos ? 1 : 0,
    images: Math.min(Math.max(0, plan.images || 0), Math.max(0, cap.images - usage.images)) };
}
function amount(plan, free, rates = filmPricing()) {
  return round6((free.videos ? 0 : Math.max(0, plan.seconds || 0)) * rates.perSecond + Math.max(0, (plan.images || 0) - free.images) * rates.perImage);
}
function dayId(user, now = new Date()) { return dayStart(now).toISOString().slice(0, 19) + ':' + String(user); }
async function status(user) {
  if (process.env.FILM_BACKEND !== 'own') return { id: dayId(user), videos: 0, images: 0, remainingVideos: 0, remainingImages: 0 };
  const id = dayId(user); const doc = await Quota.findById(id).lean();
  const used = { videos: doc?.videos || 0, images: doc?.images || 0 };
  return { id, ...used, remainingVideos: Math.max(0, limits().videos - used.videos), remainingImages: Math.max(0, limits().images - used.images) };
}
async function quote(user, plan, usage) {
  const state = usage || await status(user); const free = allocation(state, plan);
  return { price: amount(plan, free), free, state };
}
async function reserve(user, plan) {
  if (process.env.FILM_BACKEND !== 'own') return { videos: 0, images: 0, price: amount(plan, { videos: 0, images: 0 }) };
  const id = dayId(user); const token = crypto.randomBytes(12).toString('hex');
  await Quota.updateOne({ _id: id }, { $setOnInsert: { videos: 0, images: 0, holds: {}, expiresAt: new Date(Date.now() + 32 * 86400e3) } }, { upsert: true }).catch(e => { if (e.code !== 11000) throw e; });
  for (let n = 0; n < 12; n++) {
    const old = await Quota.findById(id).lean();
    const free = allocation(old, plan);
    if (!free.videos && !free.images) return { id, token, ...free, price: amount(plan, free) };
    const changed = await Quota.updateOne({ _id: id, videos: old.videos, images: old.images }, {
      $inc: { videos: free.videos, images: free.images }, $set: { ['holds.' + token]: free },
    });
    if (changed.modifiedCount) return { id, token, ...free, price: amount(plan, free) };
  }
  const e = new Error('quota is busy'); e.code = 'WALLET_BUSY'; throw e;
}
async function release(hold, { video = true, image = true } = {}) {
  if (!hold?.id || !hold.token) return;
  for (const [field, enabled] of [['videos', video], ['images', image]]) {
    if (!enabled || !(hold[field] > 0)) continue;
    const path = 'holds.' + hold.token + '.' + field;
    await Quota.updateOne({ _id: hold.id, [path]: hold[field] }, { $inc: { [field]: -hold[field] }, $set: { [path]: 0 } });
  }
}
module.exports = { limits, allocation, amount, dayId, status, quote, reserve, release };
