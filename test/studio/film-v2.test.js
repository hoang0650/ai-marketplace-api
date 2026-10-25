const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const fp = require('../../src/utils/film-pricing');
const aimx = require('../../src/utils/aimx-gpu');
const { installFakeLedger } = require('../helpers/fake-ledger');
const StudioJob = require('../../src/models/StudioJob');
const FilmProject = require('../../src/models/FilmProject');
const filmRoutes = require('../../src/routes/studio-film');

const { sceneIn, scenePlan, priceGate, debit, renderPlan } = filmRoutes._internal;
const saved = [];
after(() => { for (const [o, k, v] of saved.reverse()) o[k] = v; });

test('film pricing is RunPod cost x1.32 per second / per image, no free quota', () => {
  const p = fp.filmPricing({});
  assert.equal(p.perSecond, 0.0792);
  assert.equal(p.perImage, 0.0264);
  assert.equal(fp.filmCharge({ seconds: 30, images: 1 }, p), 2.4024);
  assert.equal(fp.filmPricing({ STUDIO_FILM_MARKUP: '0.5' }).perSecond, 0.09);
});

test('scene seconds split into Wan shot lengths up to 60 s', () => {
  assert.deepEqual(fp.splitDuration(30), [15, 15]);
  assert.deepEqual(fp.splitDuration(60), [15, 15, 15, 15]);
  assert.deepEqual(fp.splitDuration(25), [15, 10]);
  assert.deepEqual(fp.splitDuration(20), [15, 5]);
  assert.deepEqual(fp.splitDuration(7), [5]);
  assert.deepEqual(fp.splitDuration(400), [15, 15, 15, 15]);
});

test('refund covers exactly the seconds/images that were not produced', () => {
  const rates = fp.filmPricing({});
  assert.equal(fp.filmRefund({ charged: 2.4024, okSeconds: 15, okImages: 1, rates }), 1.188);
  assert.equal(fp.filmRefund({ charged: 2.4024, okSeconds: 0, okImages: 0, rates }), 2.4024);
  assert.equal(fp.filmRefund({ charged: 2.4024, okSeconds: 30, okImages: 1, rates }), 0);
});

test('film paths map to the AI service film router only', () => {
  assert.equal(aimx.providerPath('/film/scene'), '/providers/aimx/film/scene');
  assert.equal(aimx.providerPath('/film/jobs/0123456789abcdef0123456789abcdef'), '/providers/aimx/film/jobs/0123456789abcdef0123456789abcdef');
  assert.equal(aimx.providerPath('/film/jobs/../x'), null);
  assert.equal(aimx.providerPath('/film/admin'), null);
});

test('scene edits replan shots until generated, then mark stale', () => {
  const s = sceneIn({ prompt: 'a hero walks', duration: 30, shots: [{ prompt: 'walks in' }] }, null);
  assert.deepEqual(s.shots.map((x) => x.duration), [15, 15]);
  assert.equal(s.shots[0].prompt, 'walks in');
  const longer = sceneIn({ duration: 60 }, s);
  assert.equal(longer.shots.length, 4);
  assert.equal(longer.shots[0].prompt, 'walks in');
  longer.shots[0].versions = [{ v: 1, videoKey: 'k' }];
  longer.shots[0].active = 0;
  longer.status = 'ready';
  const shorter = sceneIn({ duration: 20 }, longer);
  assert.equal(shorter.status, 'stale');
  assert.equal(shorter.shots.length, 4);
  assert.equal(sceneIn({ duration: 3 }, null).duration, 5);
});

test('scene plan: text-only scenes pay one first-frame image, chained scenes reuse the previous last frame', () => {
  const p = new FilmProject({ user: new mongoose.Types.ObjectId(), scenes: [
    { sid: 'a', prompt: 'x', duration: 15, shots: [{ sid: 's1', duration: 15, active: 0, versions: [{ v: 1, videoKey: 'v', frameKey: 'f' }] }] },
    { sid: 'b', prompt: 'y', duration: 30, chainPrev: true },
    { sid: 'c', prompt: 'z', duration: 60 },
  ] });
  const b = scenePlan(p, p.scenes[1], 1);
  assert.deepEqual([b.seconds, b.images, b.price, b.start.key], [30, 0, 2.376, 'f']);
  const c = scenePlan(p, p.scenes[2], 2);
  assert.deepEqual([c.seconds, c.images, c.price], [60, 1, 4.7784]);
  assert.equal(renderPlan({ scenes: [{ narration: 'a'.repeat(2000) }] }).chars, 2000);
});

test('generation requires the estimated price the user saw', () => {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  assert.equal(priceGate({ body: {} }, res, 1.2), false);
  assert.equal(res.code, 400); assert.equal(res.body.code, 'PRICE_REQUIRED'); assert.equal(res.body.price, 1.2);
  assert.equal(priceGate({ body: { expectedPrice: 1 } }, res, 1.2), false);
  assert.equal(res.code, 409);
  assert.equal(priceGate({ body: { expectedPrice: 1.2 } }, res, 1.2), true);
});

test('parallel film debits never overdraw the wallet', async () => {
  const db = installFakeLedger({ saved });
  const user = new mongoose.Types.ObjectId();
  db.tx.push({ _id: new mongoose.Types.ObjectId(), user: String(user), type: 'credit', amount: 3, status: 'completed' });
  const r = await Promise.allSettled([1, 2, 3].map(() => debit(user, 1.2, 'film', { kind: 'film-scene' })));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 2);
  assert.equal(r.filter((x) => x.status === 'rejected' && x.reason.code === 'INSUFFICIENT_WALLET').length, 1);
});

test('settling a partial scene refunds failed shots once and versions the produced ones', async () => {
  const db = installFakeLedger({ saved });
  process.env.AIMX_PROVIDER_URL = 'http://ai.test';
  process.env.DENGLISH_SERVICE_KEY = 'k';
  const user = new mongoose.Types.ObjectId();
  const doc = new FilmProject({ user, scenes: [{ sid: 'sc', prompt: 'x', duration: 30, status: 'generating', generation: 1,
    shots: [{ sid: 'a', duration: 15, status: 'generating' }, { sid: 'b', duration: 15, status: 'generating' }] }] });
  doc.save = async () => doc;
  const stubs = [[FilmProject, 'findById', async () => doc]];
  let settledOnce = false;
  stubs.push([StudioJob, 'updateOne', async (q) => { if (q.settled && !settledOnce) { settledOnce = true; return { modifiedCount: 1 }; } return { modifiedCount: 0 }; }]);
  stubs.push([global, 'fetch', async (url) => {
    assert.match(String(url), /\/providers\/aimx\/film\/jobs\/[a-f0-9]{32}$/);
    return new Response(JSON.stringify({ status: 'partial', cost: 0.92, keyframe: { status: 'succeeded' },
      shots: [{ id: 'a', status: 'succeeded' }, { id: 'b', status: 'failed', error: 'safety' }] }), { status: 200 });
  }]);
  for (const [o, k, fn] of stubs) { saved.push([o, k, o[k]]); o[k] = fn; }
  const mk = () => ({
    _id: new mongoose.Types.ObjectId(), user, kind: 'film-scene', status: 'running', remoteId: 'ab'.repeat(16), charged: 2.4024, project: doc._id,
    createdAt: new Date(), $locals: {}, save: async () => {},
    meta: { sid: 'sc', gen: 1, keyframeKey: 'kf', rates: fp.filmPricing({}), shots: [{ sid: 'a', duration: 15, videoKey: 'va', frameKey: 'fa' }, { sid: 'b', duration: 15, videoKey: 'vb', frameKey: 'fb' }] },
  });
  const job = await filmRoutes.refreshFilmJob(mk());
  assert.equal(job.status, 'succeeded');
  assert.equal(job.refundedAmount, 1.188);
  const credits = db.tx.filter((t) => t.type === 'credit');
  assert.equal(credits.length, 1); assert.equal(credits[0].amount, 1.188);
  const sc = doc.scenes[0];
  assert.equal(sc.status, 'partial');
  assert.equal(sc.shots[0].active, 0); assert.equal(sc.shots[0].versions[0].videoKey, 'va');
  assert.equal(sc.shots[1].status, 'failed');
  assert.equal(sc.keyframes.length, 1);
  await filmRoutes.refreshFilmJob(mk()); // a second poller pass must not refund again
  assert.equal(db.tx.filter((t) => t.type === 'credit').length, 1);
});
