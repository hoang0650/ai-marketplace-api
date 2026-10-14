const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** Evaluate `code` in a fresh process so GPAY_ENABLED is read from scratch. */
function run(code, env = {}) {
  const childEnv = { ...process.env, ...env };
  if (!('GPAY_ENABLED' in env)) delete childEnv.GPAY_ENABLED;
  const out = execFileSync(process.execPath, ['-e', code], { cwd: ROOT, env: childEnv, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const FLAG = `
const c = require('./src/config/env');
const g = require('./src/utils/gpay-client');
console.log(JSON.stringify({ flag: c.gpayVaEnabled, feature: g.gpayFeatureEnabled() }));
`;

test('GPAY_ENABLED unset → GPay disabled (safe default after Dokploy redeploy)', () => {
  assert.deepEqual(run(FLAG), { flag: false, feature: false });
});

test('GPAY_ENABLED=false / 0 / empty → disabled', () => {
  for (const v of ['false', '0', '', 'no']) {
    assert.deepEqual(run(FLAG, { GPAY_ENABLED: v }), { flag: false, feature: false }, v);
  }
});

test('GPAY_ENABLED=true / 1 → enabled', () => {
  for (const v of ['true', '1', 'TRUE', ' true ']) {
    assert.deepEqual(run(FLAG, { GPAY_ENABLED: v }), { flag: true, feature: true }, v);
  }
});

test('disabled: credentials alone do not enable the gateway or QR', () => {
  const code = `
const g = require('./src/utils/gpay-client');
console.log(JSON.stringify({ portal: g.gpayPortalEnabled(), va: g.gpayVaEnabled() }));
`;
  const env = {
    GPAY_MERCHANT_CODE: 'm',
    GPAY_PASSWORD: 'p',
    GPAY_PORTAL_MERCHANT_CODE: 'm',
    GPAY_PORTAL_PASSWORD: 'p',
  };
  assert.deepEqual(run(code, env), { portal: false, va: false });
});

/** Mount the real router and hit it over HTTP (no DB needed for these paths). */
const HTTP = `
const express = require('express');
const router = require('./src/routes/gpay');
const app = express();
app.use(express.json());
app.use('/v1/gpay', router);
app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));
const srv = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port + '/v1/gpay';
  const post = (p, body = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = {};
  for (const p of ['/checkout', '/qr', '/account', '/sandbox/credit']) {
    const r = await post(p, { amountVnd: 100000 });
    out[p] = { status: r.status, code: (await r.json()).code };
  }
  const w = await post('/webhook', { merchant_order_id: 'AIM1' });
  out.webhook = { status: w.status, code: (await w.json()).code };
  const c = await fetch(base + '/config');
  const cfg = await c.json();
  out.config = { status: c.status, available: cfg.available, enabled: cfg.enabled, featureEnabled: cfg.featureEnabled };
  const ret = await fetch(base + '/return?order=AIM1', { redirect: 'manual' });
  out.return = ret.status;
  srv.close();
  console.log(JSON.stringify(out));
});
`;

test('disabled: create-payment routes return 503 GPAY_DISABLED; webhook/config/return stay up', () => {
  const out = run(HTTP, { GPAY_RELAY_SECRET: 'relay-secret' });
  for (const p of ['/checkout', '/qr', '/account', '/sandbox/credit']) {
    assert.deepEqual(out[p], { status: 503, code: 'GPAY_DISABLED' }, p);
  }
  // Webhook is not gated by the flag: it reaches its own auth check (bad relay secret → 401).
  assert.equal(out.webhook.status, 401);
  assert.equal(out.webhook.code, 'GPAY_BAD_RELAY');
  assert.deepEqual(out.config, { status: 200, available: false, enabled: false, featureEnabled: false });
  assert.equal(out.return, 302);
});

test('enabled: create-payment routes pass the flag (then require auth)', () => {
  const out = run(HTTP, { GPAY_ENABLED: 'true', GPAY_RELAY_SECRET: 'relay-secret' });
  for (const p of ['/checkout', '/qr', '/account', '/sandbox/credit']) {
    assert.notEqual(out[p].code, 'GPAY_DISABLED', p);
    assert.equal(out[p].status, 401, p);
  }
  assert.equal(out.config.available, true);
  assert.equal(out.config.featureEnabled, true);
});
