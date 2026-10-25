const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const router = require('../../src/routes/game-sessions');
const { sandboxGameHtml, sandboxTerminalHtml } = require('../../src/terminal/sandbox-players');

function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

test('dedicated server player: inline script is valid JS and polls the session URL', async () => {
  const html = router.dedicatedServerHtml({ name: 'Máy chủ Minecraft', gameServer: { connectHint: 'Multiplayer → Direct connect' } });
  const [script] = inlineScripts(html);
  assert.ok(script, 'player has an inline script');
  assert.doesNotThrow(() => new vm.Script(script));
  const fetched = [];
  const els = {};
  const el = (id) => (els[id] ||= { id, hidden: true, textContent: '', className: '' });
  const ctx = {
    location: { pathname: '/v1/game-sessions/gs_abc/player', search: '?access_token=t' },
    document: { getElementById: el },
    navigator: {},
    setTimeout: () => 0,
    fetch: async (url) => {
      fetched.push(url);
      return { json: async () => ({ status: 'live', connect: { address: '1.2.3.4:25565' }, ratePerMinute: 0.001763, ratePerHour: 0.105781, billedCost: 0, billedMinutes: 2, usedMinutes: 3, usedCost: 0.005289, estimatedCharge: 0.01 }) };
    },
  };
  vm.runInNewContext(script, ctx);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fetched, ['/v1/game-sessions/gs_abc?access_token=t']);
  assert.equal(els.addr.textContent, '1.2.3.4:25565');
  assert.equal(els.cn.hidden, false);
  // Same rounding as the product page ($0.00176/min) and a running charge while live.
  assert.match(els.bill.textContent, /Rate: \$0\.00176\/phút · min \(\$0\.11\/giờ · hour\)/);
  assert.match(els.bill.textContent, /Running: 3 phút · min · \$0\.00529 \(.*\$0\.01\)/);
});

test('dedicated server player: after stop it shows the final bill', async () => {
  const [script] = inlineScripts(router.dedicatedServerHtml({ name: 'MC', gameServer: {} }));
  const els = {};
  const el = (id) => (els[id] ||= { id, hidden: true, textContent: '', className: '' });
  vm.runInNewContext(script, {
    location: { pathname: '/v1/game-sessions/gs_abc/player', search: '' },
    document: { getElementById: el },
    navigator: {},
    setTimeout: () => 0,
    fetch: async () => ({ json: async () => ({ status: 'stopped', ratePerMinute: 0.001763, ratePerHour: 0.105781, billedCost: 0.01, billedMinutes: 3 }) }),
  });
  await new Promise((r) => setImmediate(r));
  assert.match(els.msg.textContent, /Server stopped/);
});

test('sandbox players: inline scripts are valid JS', () => {
  for (const html of [sandboxGameHtml('Game'), sandboxTerminalHtml({ title: 'GPU', gpu: 'A', hostname: 'h' })]) {
    for (const s of inlineScripts(html)) assert.doesNotThrow(() => new vm.Script(s));
  }
});
