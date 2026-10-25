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

test('scene seconds split into the 8 s / 5 s clips the Wan endpoint accepts, up to 60 s', () => {
  assert.deepEqual(fp.splitDuration(30), [8, 8, 8, 5]);
  assert.deepEqual(fp.splitDuration(60), [8, 8, 8, 8, 8, 8, 5, 5]);
  assert.deepEqual(fp.splitDuration(40), [8, 8, 8, 8, 8]);
  assert.deepEqual(fp.splitDuration(5), [5]);
  assert.deepEqual(fp.splitDuration(400), [8, 8, 8, 8, 8, 8, 5, 5]);
  for (let t = 5; t <= 60; t += 5) {
    const a = fp.splitDuration(t); const sum = a.reduce((x, y) => x + y, 0);
    assert.ok(a.every((d) => fp.WAN_DURATIONS.includes(d)) && sum >= t - 2 && sum <= Math.min(t + 1, 60), `${t} -> ${a}`);
  }
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
  assert.deepEqual(s.shots.map((x) => x.duration), [8, 8, 8, 5]);
  assert.equal(s.shots[0].prompt, 'walks in');
  const longer = sceneIn({ duration: 60 }, s);
  assert.equal(longer.shots.length, 8);
  assert.equal(longer.shots[0].prompt, 'walks in');
  longer.shots[0].versions = [{ v: 1, videoKey: 'k' }];
  longer.shots[0].active = 0;
  longer.status = 'ready';
  const shorter = sceneIn({ duration: 20 }, longer);
  assert.equal(shorter.status, 'stale');
  assert.equal(shorter.shots.length, 8);
  assert.equal(sceneIn({ duration: 3 }, null).duration, 5);
});

test('scene plan: text-only scenes pay one first-frame image, chained scenes reuse the previous last frame', () => {
  const p = new FilmProject({ user: new mongoose.Types.ObjectId(), scenes: [
    { sid: 'a', prompt: 'x', duration: 15, shots: [{ sid: 's1', duration: 8, active: 0, versions: [{ v: 1, videoKey: 'v', frameKey: 'f' }] }] },
    { sid: 'b', prompt: 'y', duration: 30, chainPrev: true },
    { sid: 'c', prompt: 'z', duration: 60 },
  ] });
  const b = scenePlan(p, p.scenes[1], 1);
  assert.deepEqual([b.seconds, b.images, b.price, b.start.key], [29, 0, 2.2968, 'f']);
  const c = scenePlan(p, p.scenes[2], 2);
  assert.deepEqual([c.seconds, c.images, c.price], [58, 1, 4.62]);
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

const FilmAsset = require('../../src/models/FilmAsset');
const minio = require('../../src/config/minio');

test('scene refs: characters with images first (image 1..n), setting image last, max 3 images, owner-scoped', async () => {
  const user = new mongoose.Types.ObjectId();
  const id = () => new mongoose.Types.ObjectId();
  const [lan, minh, ba, cafe] = [id(), id(), id(), id()];
  let query = null;
  const rows = [
    { _id: lan, type: 'character', name: 'Lan', description: 'red ao dai', images: [{ key: 'k/lan.jpg' }] },
    { _id: minh, type: 'character', name: 'Minh', description: 'denim jacket', images: [] },
    { _id: ba, type: 'character', name: 'Ba', description: 'old fisherman', images: [{ key: 'k/ba.jpg' }] },
    { _id: cafe, type: 'setting', name: 'Cafe', description: 'lantern-lit cafe', images: [{ key: 'k/cafe.jpg' }] },
  ];
  for (const [o, k, fn] of [
    [FilmAsset, 'find', (q) => { query = q; return { lean: async () => rows }; }],
    [minio, 'presignFilmGet', async (k) => `https://cdn.test/${k}`],
  ]) { saved.push([o, k, o[k]]); o[k] = fn; }
  const r = await filmRoutes._internal.sceneRefs(user, { characterIds: [minh, lan, ba], settingId: cafe });
  assert.equal(String(query.user), String(user));
  assert.deepEqual(r.images, ['https://cdn.test/k/lan.jpg', 'https://cdn.test/k/ba.jpg', 'https://cdn.test/k/cafe.jpg']);
  assert.equal(r.charImages, 2);
  assert.equal(r.settingImage, true);
  assert.deepEqual(r.characters.map((c) => c.name), ['Lan', 'Ba', 'Minh']);
  assert.equal(r.setting.description, 'lantern-lit cafe');
  const none = await filmRoutes._internal.sceneRefs(user, { characterIds: [], settingId: null });
  assert.deepEqual(none, { characters: [], setting: null, images: [], charImages: 0, settingImage: false });
});

test('library image settles once: success adds the image, failure refunds the full image price', async () => {
  const db = installFakeLedger({ saved });
  process.env.AIMX_PROVIDER_URL = 'http://ai.test';
  process.env.DENGLISH_SERVICE_KEY = 'k';
  const user = new mongoose.Types.ObjectId();
  const asset = new mongoose.Types.ObjectId();
  const assetUpdates = [];
  let remote = { status: 'succeeded', cost: 0.02 };
  for (const [o, k, fn] of [
    [StudioJob, 'updateOne', async () => ({ modifiedCount: 1 })],
    [FilmAsset, 'updateOne', async (q, u) => { assetUpdates.push(u); return { modifiedCount: 1 }; }],
    [global, 'fetch', async () => new Response(JSON.stringify(remote), { status: 200 })],
  ]) { saved.push([o, k, o[k]]); o[k] = fn; }
  const mk = () => ({ _id: new mongoose.Types.ObjectId(), user, kind: 'film-image', status: 'running', remoteId: 'cd'.repeat(16), charged: 0.0264, project: null,
    createdAt: new Date(), $locals: {}, save: async () => {}, meta: { asset: String(asset), key: 'k/g1.jpg', images: 1, rates: fp.filmPricing({}) } });
  const ok = await filmRoutes.refreshFilmJob(mk());
  assert.equal(ok.status, 'succeeded'); assert.equal(ok.refundedAmount, 0);
  assert.deepEqual(assetUpdates[0].$push.images, { key: 'k/g1.jpg', source: 'generated' });
  remote = { status: 'failed', error: 'safety', cost: 0 };
  const bad = await filmRoutes.refreshFilmJob(mk());
  assert.equal(bad.status, 'failed'); assert.equal(bad.refundedAmount, 0.0264);
  assert.equal(assetUpdates[1].$push, undefined);
  assert.equal(db.tx.filter((t) => t.type === 'credit').length, 1);
});

test('re-shooting one shot: start frame comes from the scene start or the previous take, new take becomes active', () => {
  const { shotStart, applyScene } = filmRoutes._internal;
  const doc = new FilmProject({ user: new mongoose.Types.ObjectId(), scenes: [{ sid: 'sc', prompt: 'x', duration: 15, status: 'generating', generation: 1,
    keyframes: [{ v: 1, frameKey: 'kf1' }],
    shots: [
      { sid: 'a', duration: 8, active: 0, status: 'ready', versions: [{ v: 1, videoKey: 'va1', frameKey: 'fa1', startKey: 'kf1' }] },
      { sid: 'b', duration: 8, active: -1, status: 'failed', versions: [] },
    ] }] });
  const sc = doc.scenes[0];
  assert.equal(shotStart(sc, 0), 'kf1');
  assert.equal(shotStart(sc, 1), 'fa1');
  const job = { _id: new mongoose.Types.ObjectId(), meta: { sid: 'sc', gen: 1, single: true, keyframeKey: '', startKey: '',
    shots: [{ sid: 'b', duration: 8, seed: 3, prompt: 'turns', videoKey: 'vb2', frameKey: 'fb2', startKey: '' }] } };
  assert.equal(applyScene(doc, job, { status: 'succeeded', shots: [{ id: 'b', status: 'succeeded' }] }), true);
  assert.equal(sc.shots[1].active, 0); assert.equal(sc.shots[1].versions[0].videoKey, 'vb2');
  assert.equal(sc.shots[0].versions.length, 1, 'other shots untouched');
  assert.equal(sc.status, 'ready');
  // shot 1 re-take keeps sharing the keyframe as its start; old takes beyond 10 are evicted but the shared start frame is not deleted
  for (let n = 2; n <= 11; n += 1) {
    sc.status = 'generating';
    applyScene(doc, { _id: job._id, meta: { sid: 'sc', gen: 1, single: true, keyframeKey: '', startKey: '',
      shots: [{ sid: 'a', duration: 8, seed: n, prompt: '', videoKey: `va${n}`, frameKey: `fa${n}`, startKey: 'kf1' }] } }, { status: 'succeeded', shots: [{ status: 'succeeded' }] });
  }
  assert.equal(sc.shots[0].versions.length, 10);
  assert.equal(sc.shots[0].versions[sc.shots[0].active].videoKey, 'va11');
  assert.equal(shotStart(sc, 0), 'kf1');
});
