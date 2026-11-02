const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { studioPolicy, decide } = require('../../src/utils/studio-policy');
const proxy = require('../../src/terminal/gpu-proxy');
const { publicJob } = require('../../src/routes/training-jobs');

test('TTS gives exactly ten daily free jobs, including launch promo', () => {
  const policy = studioPolicy({});
  for (const promo of [false, true]) {
    assert.equal(decide({ kind: 'tts', usedToday: 9, available: 1, policy, promo, chars: 1000 }).free, true);
    const result = decide({ kind: 'tts', usedToday: 10, available: 1, policy, promo, chars: 1000 });
    assert.notEqual(result.free, true);
    assert.equal(promo ? result.status : result.charge, promo ? 429 : 0.01);
  }
});

test('reused GPU job cost excludes earlier rental charges and freezes when finished', () => {
  const doc = { status: 'running', rentalBilledStart: 9, cost: 1, config: {} };
  const rental = { _id: 'r', status: 'running', billedTotal: 12, pricePerHour: 1 };
  assert.equal(publicJob(doc, rental).cost, 3);
  assert.equal(publicJob({ ...doc, status: 'succeeded' }, rental).cost, 1);
});

test('existing GPU launches through authenticated terminal, ignores shell echo and waits for acknowledgement', async () => {
  let authenticated = false, gotCommand = false;
  const server = http.createServer((req, res) => {
    authenticated = req.headers.authorization === 'token private-token';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: '1' }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, 'token private-token');
    ws.on('message', raw => {
      const msg = JSON.parse(raw); assert.equal(msg[0], 'stdin');
      gotCommand = true;
      ws.send(JSON.stringify(['stdout', msg[1]]));
      setTimeout(() => ws.send(JSON.stringify(['stdout', '\r\nAIM_STARTED\r\n'])), 15);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  proxy._targets.set('r', { at: Date.now(), uid: 'u', host: '127.0.0.1', port: server.address().port, tls: false, token: 'private-token' });
  try {
    await proxy.launchTraining('r', 'u', { jobId: 'tj_1234567890abcdef', bootstrapUrl: 'https://cdn.example/bootstrap.py', manifestUrl: 'https://cdn.example/manifest', token: 'job-token' });
    assert.equal(authenticated, true); assert.equal(gotCommand, true);
    await assert.rejects(proxy.launchTraining('r', 'u', { jobId: '../invalid' }));
  } finally {
    proxy._targets.delete('r'); for (const ws of wss.clients) ws.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});
