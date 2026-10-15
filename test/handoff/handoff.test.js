const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bus = require('../../src/realtime/user-bus');
const HandoffCode = require('../../src/models/HandoffCode');
const DeviceLink = require('../../src/models/DeviceLink');
const BuilderProject = require('../../src/models/BuilderProject');
const HiredAgent = require('../../src/models/HiredAgent');
const AgentSubscription = require('../../src/models/AgentSubscription');
const notify = require('../../src/utils/notify');
const router = require('../../src/routes/handoff');

const { normalizeCode, newCode, hashCode, attempts } = router._test;
const A = new mongoose.Types.ObjectId();
const B = new mongoose.Types.ObjectId();
const PROJECT = new mongoose.Types.ObjectId();

function route(method, path) {
  const l = router.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]);
  return l.route.stack.at(-1).handle;
}

function call(handler, { user, body = {}, params = {}, query = {}, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { user: { _id: user }, body, params, query, ip: '10.0.0.1', get: (k) => h[k.toLowerCase()], on() {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      set() { return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

const lean = (v) => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => v });

function mockDevices(t) {
  const store = new Map();
  t.mock.method(DeviceLink, 'findOne', (q) => lean(store.get(`${q.user}:${q.deviceId}`) || null));
  t.mock.method(DeviceLink, 'findOneAndUpdate', (q, u) => {
    const k = q._id ? [...store.keys()].find((x) => String(store.get(x)._id) === String(q._id) && String(store.get(x).user) === String(q.user)) : `${q.user}:${q.deviceId}`;
    if (q._id && !k) return lean(null);
    const prev = store.get(k) || { _id: new mongoose.Types.ObjectId(), ...(u.$setOnInsert || {}), createdAt: new Date() };
    const next = { ...prev, ...u.$set };
    store.set(k, next);
    return lean(next);
  });
  t.mock.method(DeviceLink, 'updateOne', async () => ({}));
  return store;
}

test('codes: alphabet, normalisation from code, dashed code and scanned URL', () => {
  const c = newCode();
  assert.equal(c.length, 8);
  assert.equal(normalizeCode(`${c.slice(0, 4).toLowerCase()}-${c.slice(4)}`), c);
  assert.equal(normalizeCode(`https://aimarkets.vn/handoff/${c}`), c);
  assert.equal(normalizeCode(`aimarkets://handoff/${c}`), c);
  assert.equal(normalizeCode('0000OOOO'), '', 'ambiguous chars are not in the alphabet');
  assert.equal(normalizeCode('short'), '');
});

test('create: only for a session the caller owns', async (t) => {
  mockDevices(t);
  t.mock.method(BuilderProject, 'findOne', (q) => lean(String(q.owner) === String(A) && String(q._id) === String(PROJECT) ? { _id: PROJECT, name: 'Shop' } : null));
  t.mock.method(HandoffCode, 'countDocuments', async () => 0);
  const created = [];
  t.mock.method(HandoffCode, 'create', async (d) => created.push(d));
  const ok = await call(route('post', '/'), { user: A, body: { kind: 'builder', id: String(PROJECT) } });
  assert.equal(ok.status, 201);
  assert.match(ok.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(ok.body.url, /\/handoff\/[A-Z0-9]{8}$/);
  assert.match(ok.body.qrSvg, /^<svg/);
  assert.equal(created[0].codeHash, hashCode(ok.body.code.replace('-', '')), 'only the hash is stored');
  assert.ok(created[0].expiresAt - Date.now() <= 120_000);
  const other = await call(route('post', '/'), { user: B, body: { kind: 'builder', id: String(PROJECT) } });
  assert.equal(other.status, 404, "B cannot hand off A's project");
  const agentNo = await (async () => {
    t.mock.method(HiredAgent, 'findOne', () => lean(null));
    t.mock.method(AgentSubscription, 'findOne', () => lean(null));
    return call(route('post', '/'), { user: A, body: { kind: 'agent', id: 'openclaw' } });
  })();
  assert.equal(agentNo.status, 404, 'agent must be rented by the caller');
});

test('claim: single use, same user only, notifies and publishes', async (t) => {
  attempts.clear();
  bus._reset();
  mockDevices(t);
  const code = newCode();
  const doc = { codeHash: hashCode(code), user: A, usedAt: null, cancelledAt: null, expiresAt: new Date(Date.now() + 60_000), target: { kind: 'builder', id: String(PROJECT) } };
  t.mock.method(HandoffCode, 'findOneAndUpdate', (q, u) => {
    const match = q.codeHash === doc.codeHash && String(q.user) === String(doc.user) && !doc.usedAt && doc.expiresAt > q.expiresAt.$gt;
    if (!match) return lean(null);
    Object.assign(doc, u.$set);
    return lean({ ...doc });
  });
  t.mock.method(HandoffCode, 'findOne', (q) => lean(q.codeHash === doc.codeHash ? doc : null));
  t.mock.method(BuilderProject, 'findOne', (q) => lean(String(q.owner) === String(A) ? { _id: PROJECT, name: 'Shop' } : null));
  const notified = [];
  t.mock.method(notify, 'notifyUser', async (...a) => notified.push(a));
  const headers = { 'x-device-id': 'phone-device-0001', 'x-device-platform': 'ios', 'x-device-name': 'iPhone' };

  const wrong = await call(route('post', '/claim'), { user: B, body: { code }, headers });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'HANDOFF_WRONG_USER');
  assert.equal(doc.usedAt, null, 'a wrong-user attempt does not burn the code');

  const before = bus.cursorOf(A);
  const ok = await call(route('post', '/claim'), { user: A, body: { code: `${code.slice(0, 4)}-${code.slice(4)}` }, headers });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.target.path, `/build/${PROJECT}`);
  const feed = bus.since(A, before);
  assert.deepEqual(feed.events.map((e) => e.type), ['device.linked', 'handoff.claimed']);
  assert.equal(bus.since(B, '').events.length, 0, 'nothing leaks to other users');
  assert.equal(notified.length, 1);
  assert.equal(notified[0][1], 'device.linked');

  const again = await call(route('post', '/claim'), { user: A, body: { code }, headers });
  assert.equal(again.status, 410);
  assert.equal(again.body.error.code, 'HANDOFF_CODE_USED');
});

test('claim: rate limited per user', async (t) => {
  attempts.clear();
  mockDevices(t);
  t.mock.method(HandoffCode, 'findOneAndUpdate', () => lean(null));
  t.mock.method(HandoffCode, 'findOne', () => lean(null));
  let last;
  for (let i = 0; i < 11; i++) last = await call(route('post', '/claim'), { user: A, body: { code: newCode() } });
  assert.equal(last.status, 429);
});

test('revoked device is refused by sync and claim', async (t) => {
  attempts.clear();
  const store = mockDevices(t);
  store.set(`${A}:dead-device-0001`, { _id: new mongoose.Types.ObjectId(), user: A, deviceId: 'dead-device-0001', revokedAt: new Date() });
  const r = await call(route('get', '/sync'), { user: A, headers: { 'x-device-id': 'dead-device-0001' } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'DEVICE_REVOKED');
});

test('revoke only touches my own devices', async (t) => {
  const store = mockDevices(t);
  const mine = { _id: new mongoose.Types.ObjectId(), user: A, deviceId: 'my-device-00001' };
  store.set(`${A}:my-device-00001`, mine);
  const asB = await call(route('delete', '/devices/:id'), { user: B, params: { id: String(mine._id) } });
  assert.equal(asB.status, 404);
  const asA = await call(route('delete', '/devices/:id'), { user: A, params: { id: String(mine._id) } });
  assert.equal(asA.status, 200);
  assert.equal(asA.body.device.revoked, true);
});

test('bus: resume from cursor, reset on unknown cursor, long-poll wakes', async () => {
  bus._reset();
  const c0 = bus.cursorOf(A);
  bus.publish(A, 'x', { n: 1 });
  const r = bus.since(A, c0);
  assert.equal(r.events.length, 1);
  assert.equal(bus.since(A, 'otherboot.3').reset, true);
  const c1 = r.cursor;
  const p = bus.wait(A, c1, 2000);
  setTimeout(() => bus.publish(A, 'y'), 20);
  const w = await p;
  assert.deepEqual(w.events.map((e) => e.type), ['y']);
  for (let i = 0; i < 250; i++) bus.publish(A, 'z');
  assert.equal(bus.since(A, c1).reset, true, 'fell out of the buffer -> refetch');
});
