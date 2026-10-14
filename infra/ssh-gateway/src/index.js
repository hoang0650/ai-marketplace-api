const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('ssh2');
const { loadConfig } = require('./config');
const { ApiClient } = require('./api');
const { DockerClient } = require('./docker');
const { FailLimiter, Registry, handleClient, reapOnce } = require('./gateway');

function log(event, fields = {}) {
  // Never log passwords or secrets; only event names, IPs and sandbox keys.
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

function loadHostKey(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 3072,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    fs.writeFileSync(file, privateKey, { mode: 0o600 });
    log('host_key_generated', { file });
  }
  return fs.readFileSync(file);
}

function createServer(deps, hostKey) {
  return new Server({ hostKeys: [hostKey], ident: 'SSH-2.0-aimarkets-sandbox' }, (client, info) =>
    handleClient(client, info, deps)
  );
}

function main() {
  const cfg = loadConfig();
  const deps = {
    cfg,
    api: new ApiClient(cfg),
    docker: new DockerClient(cfg.dockerHost),
    registry: new Registry(),
    limiter: new FailLimiter(cfg.authFailWindowMs, cfg.authFailMax),
    log,
  };
  const server = createServer(deps, loadHostKey(cfg.hostKeyPath));
  server.on('error', (err) => log('server_error', { error: err.message }));
  server.listen(cfg.listenPort, '0.0.0.0', () => log('listening', { port: cfg.listenPort }));

  const tick = () =>
    reapOnce(deps)
      .catch((err) => log('reap_skipped', { error: err.message }))
      .finally(() => setTimeout(tick, cfg.reapIntervalMs).unref());
  setTimeout(tick, 5000).unref();
}

if (require.main === module) main();

module.exports = { createServer };
