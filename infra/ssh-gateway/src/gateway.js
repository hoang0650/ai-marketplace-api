const { channelCommand, identityKey } = require('./sandbox-spec');
const { createDemuxer } = require('./docker');

const USERNAME_RE = /^(oc|hm|nc|sb)-([a-f0-9]{24})$/;
const PREFIX = { oc: 'openclaw', hm: 'hermes', nc: 'nanoclaw', sb: 'spacebot' };

function parseUsername(username) {
  const m = USERNAME_RE.exec(String(username || ''));
  return m ? { agentId: PREFIX[m[1]], userId: m[2] } : null;
}

/** Simple per-IP failed-auth limiter. */
class FailLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }
  blocked(ip, now = Date.now()) {
    const h = this.hits.get(ip);
    if (!h || now - h.start > this.windowMs) return false;
    return h.count >= this.max;
  }
  fail(ip, now = Date.now()) {
    const h = this.hits.get(ip);
    if (!h || now - h.start > this.windowMs) this.hits.set(ip, { start: now, count: 1 });
    else h.count += 1;
  }
}

/**
 * Wires one ssh2 client connection: password auth against the API, then every
 * session channel becomes a docker exec inside that buyer's sandbox only.
 * Port forwarding, agent forwarding and X11 are refused.
 */
function handleClient(client, info, deps) {
  const { api, docker, cfg, registry, limiter, log } = deps;
  const ip = info?.ip || 'unknown';
  let ident = null;
  let expiryTimer = null;

  client.on('authentication', async (ctx) => {
    if (limiter.blocked(ip)) return ctx.reject();
    if (ctx.method !== 'password') return ctx.reject(['password']);
    const wanted = parseUsername(ctx.username);
    if (!wanted) {
      limiter.fail(ip);
      return ctx.reject(['password']);
    }
    const res = await api.verify(ctx.username, ctx.password);
    if (!res || res.userId !== wanted.userId || res.agentId !== wanted.agentId) {
      limiter.fail(ip);
      log('auth_fail', { ip, user: ctx.username });
      return ctx.reject(['password']);
    }
    if (registry.count(identityKey(res)) >= cfg.maxConnsPerSandbox) return ctx.reject();
    ident = res;
    return ctx.accept();
  });

  client.on('ready', () => {
    const key = identityKey(ident);
    registry.add(key, client);
    log('login', { ip, sandbox: key });
    const ms = Date.parse(ident.expiresAt) - Date.now();
    expiryTimer = setTimeout(() => client.end(), Math.max(0, Math.min(ms, 2 ** 31 - 1)));

    client.on('session', (accept) => {
      const session = accept();
      let pty = null;
      let current = null;
      session.on('pty', (ok, _rej, p) => {
        pty = p;
        if (ok) ok();
      });
      session.on('window-change', (ok, _rej, p) => {
        if (current?.execId && pty) docker.resize(current.execId, p.cols, p.rows).catch(() => {});
        if (ok) ok();
      });
      session.on('env', (ok) => ok && ok());
      session.on('signal', (ok) => ok && ok());
      session.on('x11', (_ok, rej) => rej && rej());
      session.on('auth-agent', (_ok, rej) => rej && rej());

      const run = async (acceptCh, kind, command, tty) => {
        const channel = acceptCh();
        try {
          const containerId = await docker.ensureSandbox(ident, cfg.sandbox);
          current = await docker.exec(
            containerId,
            { cmd: channelCommand(kind, command), tty, cols: pty?.cols, rows: pty?.rows, term: pty?.term },
            cfg.sandbox.uid
          );
          pipe(channel, current, tty, docker);
        } catch (err) {
          log('sandbox_error', { sandbox: key, error: err.message });
          channel.stderr.write('Sandbox is unavailable right now. Please try again shortly.\r\n');
          channel.exit(1);
          channel.end();
        }
      };
      session.on('shell', (ok) => run(ok, 'shell', null, true));
      session.on('exec', (ok, _rej, p) => run(ok, 'exec', p.command, Boolean(pty)));
      session.on('subsystem', (ok, rej, p) => (p.name === 'sftp' ? run(ok, 'sftp', null, false) : rej()));
    });
    client.on('tcpip', (_ok, rej) => rej());
    client.on('openssh.streamlocal', (_ok, rej) => rej());
    client.on('request', (_ok, rej) => rej && rej());
  });

  const cleanup = () => {
    clearTimeout(expiryTimer);
    if (ident) registry.remove(identityKey(ident), client);
  };
  client.on('close', cleanup);
  client.on('end', cleanup);
  client.on('error', () => cleanup());
}

function pipe(channel, { execId, socket }, tty, docker) {
  if (tty) socket.on('data', (d) => channel.write(d));
  else socket.on('data', createDemuxer((d) => channel.write(d), (d) => channel.stderr.write(d)));
  channel.on('data', (d) => socket.write(d));
  channel.on('eof', () => socket.end());
  channel.on('close', () => socket.destroy());
  socket.on('error', () => channel.close());
  socket.on('close', async () => {
    const code = await docker.exitCode(execId).catch(() => 0);
    try {
      channel.exit(code);
      channel.end();
    } catch {
      /* channel already closed */
    }
  });
}

/** Live connections per sandbox, so revoke/expiry can drop them. */
class Registry {
  constructor() {
    this.map = new Map();
  }
  add(key, client) {
    if (!this.map.has(key)) this.map.set(key, new Set());
    this.map.get(key).add(client);
  }
  remove(key, client) {
    const s = this.map.get(key);
    if (!s) return;
    s.delete(client);
    if (!s.size) this.map.delete(key);
  }
  count(key) {
    return this.map.get(key)?.size || 0;
  }
  keys() {
    return [...this.map.keys()];
  }
  endAll(key) {
    for (const c of this.map.get(key) || []) c.end();
  }
}

/**
 * Reaper: anything (container or live connection) without an active API
 * session is torn down. Workspace volumes are kept so buyer files survive
 * between sessions; delete them when the subscription is purged.
 */
async function reapOnce({ api, docker, registry, log }) {
  const active = new Set((await api.active()).map(identityKey));
  for (const key of registry.keys()) {
    if (!active.has(key)) {
      log('revoke_connections', { sandbox: key });
      registry.endAll(key);
    }
  }
  for (const c of await docker.listSandboxes()) {
    const key = identityKey(c);
    if (!active.has(key)) {
      log('remove_sandbox', { sandbox: key });
      await docker.removeContainer(c.id).catch((err) => log('remove_error', { sandbox: key, error: err.message }));
    }
  }
}

module.exports = { parseUsername, FailLimiter, Registry, handleClient, reapOnce };
