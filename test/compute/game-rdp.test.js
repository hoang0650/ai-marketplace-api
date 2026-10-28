const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const mongoose = require('mongoose');
const { sealSecret } = require('../../src/utils/secret-box');
const rdp = require('../../src/utils/rdp-access');
const hosting = require('../../src/utils/game-hosting');
const provider = require('../../src/utils/gpu-rental/provider');
const GameSession = require('../../src/models/GameSession');
const GpuServer = require('../../src/models/GpuServer');
const router = require('../../src/routes/game-sessions');
const { withDesktop } = require('../../src/data/game-rdp-products');
const restore = [];
function stub(o, k, fn) { const old = o[k]; o[k] = fn; restore.push(() => { o[k] = old; }); }
afterEach(() => { while (restore.length) restore.pop()(); });
test('RDP credentials are encrypted, excluded from normal reads, and never embedded in .rdp files', () => {
  process.env.BYOK_ENCRYPTION_KEY = 'test-only-key-32-characters-minimum';
  const s = { status: 'live', rdpPrivatePort: 3389, rdpHost: '203.0.113.5', rdpPort: 12444, rdpPasswordEncrypted: sealSecret('a-long-per-session-password') };
  assert.equal(GameSession.schema.path('rdpPasswordEncrypted').options.select, false);
  assert.equal(rdp.credentials(s).password, 'a-long-per-session-password');
  const text = rdp.profile(s).toString('utf16le');
  assert.match(text, /full address:s:203.0.113.5:12444/);
  assert.ok(!text.includes('password'));
  assert.equal(rdp.credentials({ ...s, status: 'stopped' }), null);
  assert.equal(rdp.profile({ ...s, rdpHost: 'host\r\nmalicious:i:1' }), null);
});
test('RDP routes authenticate and scope secret reads to the requesting session owner', async () => {
  for (const path of ['/:sessionId/rdp/credentials', '/:sessionId/rdp/file']) {
    const route = router.stack.find(s => s.route?.path === path).route;
    assert.equal(route.stack.length, 2);
    let query, result;
    stub(GameSession, 'findOne', q => { query = q; return { select: async () => null, then: r => r(null) }; });
    const res = { status: n => { result = n; return res; }, json: () => {} };
    await route.stack.at(-1).handle({ params: { sessionId: 'gs_private' }, user: { _id: 'owner-1' } }, res, e => { throw e; });
    assert.deepEqual(query, { sessionId: 'gs_private', user: 'owner-1' });
    assert.equal(result, 404);
  }
});
test('launch exposes both ports, generates fresh secrets, and stores only an encrypted password', async () => {
  process.env.BYOK_ENCRYPTION_KEY = 'test-only-key-32-characters-minimum';
  const requests = [];
  stub(provider, 'createServer', async spec => { requests.push(spec); return { id: 'pod', costPerHour: 0.08 }; });
  stub(GpuServer, 'create', async doc => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
  stub(GameSession, 'create', async doc => doc);
  const product = { slug: 'mc', name: 'Minecraft', creator: 'seller', _id: 'p', gameServer: { game: 'minecraft-java', image: 'image', port: 25565, rdpPort: 3389, env: { EULA: 'TRUE' } } };
  const args = { product, user: { _id: 'buyer' }, sessionId: 'gs_test', client: 'pc', device: 'pc' };
  const a = await hosting.launchDedicatedServer(args), b = await hosting.launchDedicatedServer(args);
  assert.equal(requests[0].ports, '25565/tcp,3389/tcp');
  assert.ok(requests[0].env.AIM_RDP_PASSWORD.length >= 32);
  assert.notEqual(requests[0].env.AIM_RDP_PASSWORD, requests[1].env.AIM_RDP_PASSWORD);
  assert.ok(!JSON.stringify(a).includes(requests[0].env.AIM_RDP_PASSWORD));
  assert.equal(a.rdpUsername, 'player'); assert.equal(b.status, 'starting');
});
test('billing remains stopped until game and RDP are both ready', async () => {
  stub(provider, 'tcpEndpoint', async (_id, port) => ({ host: '203.0.113.5', port }));
  stub(hosting, 'probeTcp', async () => true);
  stub(hosting, 'probeRdp', async () => false);
  let updated = false;
  stub(GameSession, 'findOneAndUpdate', async () => { updated = true; });
  const s = { dedicated: true, status: 'starting', rdpPrivatePort: 3389, privatePort: 25565, createdAt: new Date() };
  assert.equal(await hosting.refreshDedicated(s), s); assert.equal(updated, false);
});
test('readiness checks the RDP TLS negotiation, not merely an open TCP socket', async () => {
  const server = net.createServer(socket => socket.once('data', () => socket.end(Buffer.from('030000130ed000000000000200080001000000', 'hex'))));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { assert.equal(await hosting.probeRdp('127.0.0.1', server.address().port), true); }
  finally { await new Promise(r => server.close(r)); }
});
test('RDP product price includes its 20 GB disk and preserves the game port', () => {
  process.env.GAME_RDP_IMAGE = 'verified-image';
  const p = withDesktop({ name: 'Game', tagline: '', description: '', tags: [], pricing: {}, gameServer: { port: 7777 }, apiDocsMarkdown: '' }, 0.06);
  assert.equal(p.gameServer.port, 7777); assert.equal(p.gameServer.rdpPort, 3389);
  assert.equal(p.pricing.usageRate, Math.round(hosting.dedicatedRatePerHour(0.06, 20) / 60 * 1e6) / 1e6);
  delete process.env.GAME_RDP_IMAGE;
});
