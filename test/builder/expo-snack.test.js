const test = require('node:test');
const assert = require('node:assert/strict');
const ExpoSnack = require('../../src/models/ExpoSnack');
const snack = require('../../src/utils/builder/expo-snack');

const FILES = [
  { path: 'App.tsx', content: "export default function App(){return null}" },
  { path: 'src/data.ts', content: 'export const x = 1;' },
  { path: 'app.json', content: '{"expo":{"name":"x"}}' },
  { path: 'README.md', content: '# hi' },
  { path: 'assets/icon.png', content: 'binary' },
  { path: 'package.json', content: JSON.stringify({ dependencies: { expo: '~53.0.0', 'expo-status-bar': '~2.2.0', react: '19.0.0', 'react-native': '0.79.2', dayjs: '^1.11.0' } }) },
];

function okFetch(calls, id = 'abc123') {
  return async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ id }) };
  };
}

test('payload targets the configured SDK, maps deps, drops package.json and binaries', () => {
  const p = snack.buildPayload({ name: 'Mây', files: FILES }, '54.0.0');
  assert.equal(p.manifest.sdkVersion, '54.0.0');
  assert.deepEqual(Object.keys(p.code).sort(), ['App.tsx', 'README.md', 'app.json', 'src/data.ts']);
  assert.deepEqual(p.dependencies, { 'expo-status-bar': { version: '*' }, dayjs: { version: '^1.11.0' } });
  assert.equal(snack.templateSdk(FILES), '53.0.0');
});

test('payload without an App entry is rejected', () => {
  assert.throws(() => snack.buildPayload({ files: [{ path: 'index.js', content: '' }] }, '54.0.0'), { code: 'SNACK_NO_ENTRY' });
});

test('exp:// link points at the Snack runtime for the SDK', () => {
  const u = snack.snackUrl('54.0.0', 'abc');
  assert.equal(u, `exp://u.expo.dev/${snack.SNACK_RUNTIME_PROJECT}?runtime-version=exposdk%3A54.0.0&channel-name=production&snack=abc`);
});

test('publishes once and reuses the cache while files are unchanged', async (t) => {
  let store = null;
  t.mock.method(ExpoSnack, 'findOne', () => ({ lean: async () => store }));
  t.mock.method(ExpoSnack, 'findOneAndUpdate', (_q, u) => ({ lean: async () => (store = { ...(store || {}), ...u.$set }) }));
  const calls = [];
  const a = await snack.ensureSnack('tpl:1', { name: 'x', files: FILES }, { fetchImpl: okFetch(calls), bundled: { 'expo-status-bar': '~3.0.9' } });
  const b = await snack.ensureSnack('tpl:1', { name: 'x', files: FILES }, { fetchImpl: okFetch(calls), bundled: { 'expo-status-bar': '~3.0.9' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.dependencies['expo-status-bar'].version, '~3.0.9');
  assert.equal(calls[0].body.manifest.dependencies['expo-status-bar'], '~3.0.9');
  assert.equal(a.url, b.url);
  assert.match(a.url, /snack=abc123/);
  assert.equal(a.retargeted, true);
  assert.equal(a.webUrl, 'https://snack.expo.dev/abc123');
  // Changing a file republishes.
  const changed = FILES.map((f) => (f.path === 'App.tsx' ? { ...f, content: f.content + '\n' } : f));
  const c = await snack.ensureSnack('tpl:1', { name: 'x', files: changed }, { fetchImpl: okFetch(calls, 'def456'), bundled: {} });
  assert.equal(calls.length, 2);
  assert.match(c.url, /snack=def456/);
});

test('a failed publish is reported, remembered, and keeps the older link', async (t) => {
  let store = { key: 'tpl:2', hash: 'old', url: 'exp://old', snackId: 'old', sdkVersion: '54.0.0' };
  t.mock.method(ExpoSnack, 'findOne', () => ({ lean: async () => store }));
  t.mock.method(ExpoSnack, 'findOneAndUpdate', (_q, u) => ({ lean: async () => (store = { ...store, ...u.$set }) }));
  let n = 0;
  const bad = async () => { n++; return { ok: false, status: 500, json: async () => ({}) }; };
  const r = await snack.ensureSnack('tpl:2', { files: FILES }, { fetchImpl: bad, bundled: {} });
  assert.equal(r.url, 'exp://old');
  assert.equal(r.stale, true);
  assert.equal(r.error, 'SNACK_SAVE_FAILED');
  await snack.ensureSnack('tpl:2', { files: FILES }, { fetchImpl: bad, bundled: {} });
  assert.equal(n, 1, 'retry is throttled');
});

test('can be switched off', async (t) => {
  process.env.EXPO_SNACK_ENABLED = '0';
  t.after(() => delete process.env.EXPO_SNACK_ENABLED);
  const r = await snack.ensureSnack('tpl:3', { files: FILES });
  assert.equal(r.enabled, false);
  assert.equal(r.url, '');
});
