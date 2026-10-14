const http = require('http');
const { LABEL, sandboxName, containerSpec, assertSafeSpec } = require('./sandbox-spec');

/** Tiny Docker Engine API client (unix socket or tcp://, e.g. a socket proxy). */
function connectionOptions(dockerHost) {
  if (dockerHost.startsWith('unix://')) return { socketPath: dockerHost.slice('unix://'.length) };
  const u = new URL(dockerHost.replace(/^tcp:/, 'http:'));
  return { host: u.hostname, port: Number(u.port || 2375) };
}

class DockerClient {
  constructor(dockerHost) {
    this.base = connectionOptions(dockerHost);
    this.locks = new Map();
  }

  request(method, path, body, { upgrade = false } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = { Host: 'docker' };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      if (upgrade) {
        headers.Connection = 'Upgrade';
        headers.Upgrade = 'tcp';
      }
      const req = http.request({ ...this.base, method, path: `/v1.43${path}`, headers });
      req.on('error', reject);
      if (upgrade) {
        req.on('upgrade', (res, socket, head) => {
          if (head && head.length) socket.unshift(head);
          resolve(socket);
        });
      }
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          if (res.statusCode >= 400) {
            const err = new Error(`docker ${method} ${path.split('?')[0]} -> ${res.statusCode}`);
            err.statusCode = res.statusCode;
            reject(err);
          } else resolve(json);
        });
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async inspect(name) {
    try {
      return await this.request('GET', `/containers/${encodeURIComponent(name)}/json`);
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  /** Create (if needed) and start the buyer's sandbox. Serialised per sandbox. */
  async ensureSandbox(ident, cfg) {
    const name = sandboxName(ident);
    const prev = this.locks.get(name) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      let info = await this.inspect(name);
      if (!info) {
        const spec = assertSafeSpec(containerSpec(ident, cfg));
        await this.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec);
        info = await this.inspect(name);
      }
      if (info.Config?.Labels?.[LABEL] !== '1') throw new Error('name collision with a non-sandbox container');
      if (!info.State?.Running) await this.request('POST', `/containers/${info.Id}/start`);
      return info.Id;
    });
    this.locks.set(name, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(name) === run) this.locks.delete(name);
    }
  }

  async exec(containerId, { cmd, tty, cols, rows, term, env = [] }, uid) {
    const created = await this.request('POST', `/containers/${containerId}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: Boolean(tty),
      User: `${uid}:${uid}`,
      WorkingDir: '/workspace',
      Env: [`TERM=${/^[\w.-]{1,32}$/.test(term || '') ? term : 'xterm-256color'}`, ...env],
      Cmd: cmd,
      Privileged: false,
    });
    const socket = await this.request('POST', `/exec/${created.Id}/start`, { Detach: false, Tty: Boolean(tty) }, { upgrade: true });
    if (tty && cols && rows) await this.resize(created.Id, cols, rows).catch(() => {});
    return { execId: created.Id, socket };
  }

  resize(execId, cols, rows) {
    return this.request('POST', `/exec/${execId}/resize?h=${Number(rows) | 0}&w=${Number(cols) | 0}`);
  }

  async exitCode(execId) {
    const info = await this.request('GET', `/exec/${execId}/json`);
    return Number.isInteger(info?.ExitCode) ? info.ExitCode : 0;
  }

  async listSandboxes() {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL}=1`] }));
    const rows = await this.request('GET', `/containers/json?all=1&filters=${filters}`);
    return (rows || []).map((c) => ({
      id: c.Id,
      agentId: c.Labels?.[`${LABEL}.agent`],
      userId: c.Labels?.[`${LABEL}.user`],
    }));
  }

  removeContainer(id) {
    return this.request('DELETE', `/containers/${id}?force=1&v=0`);
  }
}

/**
 * Docker multiplexes stdout/stderr for non-TTY execs as frames:
 * [stream(1) 0 0 0 size(4 BE)] payload. Returns a push-parser.
 */
function createDemuxer(onStdout, onStderr) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      const payload = buf.subarray(8, 8 + size);
      if (buf[0] === 2) onStderr(payload);
      else onStdout(payload);
      buf = buf.subarray(8 + size);
    }
  };
}

module.exports = { DockerClient, createDemuxer, connectionOptions };
