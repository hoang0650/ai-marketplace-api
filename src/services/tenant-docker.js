const http = require('http');

/**
 * Docker Engine client for the tenant runtime. Talks to the same docker-proxy
 * the SSH gateway uses (TENANT_DOCKER_HOST=tcp://docker-proxy:2375).
 * Provider keys are not sent as container Env; putFile writes /run/secrets.
 */

function connectionOptions(dockerHost) {
  if (String(dockerHost).startsWith('unix://')) return { socketPath: dockerHost.slice('unix://'.length) };
  const u = new URL(String(dockerHost).replace(/^tcp:/, 'http:'));
  return { host: u.hostname, port: Number(u.port || 2375) };
}

function tarFile(pathName, contents, mode) {
  const name = pathName.replace(/^\/+/, '');
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0'), 100, 8, 'utf8');
  header.write('0'.repeat(7), 108, 8, 'utf8');
  header.write('0'.repeat(7), 116, 8, 'utf8');
  header.write(data.length.toString(8).padStart(11, '0'), 124, 12, 'utf8');
  header.write('0'.repeat(11), 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write('0', 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(pad + 1024, 0)]);
}

class TenantDocker {
  constructor(dockerHost) {
    this.base = connectionOptions(dockerHost);
  }

  request(method, path, body, { raw = false, contentType = 'application/json' } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const headers = { Host: 'docker' };
      if (payload) {
        headers['Content-Type'] = contentType;
        headers['Content-Length'] = payload.length;
      }
      const req = http.request({ ...this.base, method, path: `/v1.43${path}`, headers });
      req.on('error', reject);
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          if (!raw) {
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              json = null;
            }
          }
          if (res.statusCode >= 400) {
            const err = new Error(`docker ${method} ${path.split('?')[0]} -> ${res.statusCode}`);
            err.statusCode = res.statusCode;
            reject(err);
          } else resolve(raw ? buf : json);
        });
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async ensureNetwork(spec) {
    try {
      await this.request('POST', '/networks/create', spec);
    } catch (err) {
      if (err.statusCode !== 409) throw err;
    }
    const info = await this.request('GET', `/networks/${encodeURIComponent(spec.Name)}`);
    const gateway = info?.IPAM?.Config?.[0]?.Gateway || '';
    return { gateway, id: info?.Id || '' };
  }

  async ensureVolume(name) {
    try {
      await this.request('POST', '/volumes/create', { Name: name, Labels: { 'vn.aimarkets.tenant': '1' } });
    } catch (err) {
      if (err.statusCode !== 409) throw err;
    }
  }

  async ensureContainer(name, spec) {
    try {
      const info = await this.request('GET', `/containers/${encodeURIComponent(name)}/json`);
      if (info?.Config?.Labels?.['vn.aimarkets.tenant'] !== '1') {
        throw new Error('name collision with a non-tenant container');
      }
      return info;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
    await this.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec);
    return this.request('GET', `/containers/${encodeURIComponent(name)}/json`);
  }

  async start(name) {
    try {
      await this.request('POST', `/containers/${encodeURIComponent(name)}/start`);
    } catch (err) {
      if (err.statusCode !== 304) throw err;
    }
  }

  async stop(name) {
    try {
      await this.request('POST', `/containers/${encodeURIComponent(name)}/stop?t=5`);
    } catch (err) {
      if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
    }
  }

  async removeContainer(name) {
    try {
      await this.request('DELETE', `/containers/${encodeURIComponent(name)}?force=1`);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }

  async removeVolume(name) {
    await this.request('DELETE', `/volumes/${encodeURIComponent(name)}?force=1`);
  }

  /**
   * Copy `from` onto a new volume `to` with a short-lived helper container.
   * The source is mounted read-only. `copied` is true only after exit 0,
   * which is what purge checks before it deletes the source.
   */
  async copyVolume(from, to) {
    if (from === to) throw new Error('refusing to copy a volume onto itself');
    await this.ensureVolume(to);
    const name = `aim-vol-copy-${Date.now().toString(36)}`;
    const created = await this.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, {
      Image: process.env.TENANT_COPY_IMAGE || 'busybox:1.36',
      Cmd: ['sh', '-c', 'cp -a /src/. /dest/'],
      User: '0:0',
      HostConfig: {
        AutoRemove: false,
        CapDrop: ['ALL'],
        ReadonlyRootfs: true,
        NetworkMode: 'none',
        Mounts: [
          { Type: 'volume', Source: from, Target: '/src', ReadOnly: true },
          { Type: 'volume', Source: to, Target: '/dest', ReadOnly: false },
        ],
      },
      Labels: { 'vn.aimarkets.tenant-copy': '1' },
    });
    const id = created?.Id || name;
    try {
      await this.request('POST', `/containers/${id}/start`);
      const wait = await this.request('POST', `/containers/${id}/wait`);
      if (!wait || wait.StatusCode !== 0) throw new Error('volume copy failed');
      return { from, to, copied: true };
    } finally {
      await this.request('DELETE', `/containers/${id}?force=1`).catch(() => {});
    }
  }

  async putFile(container, filePath, contents, mode) {
    const dir = filePath.replace(/\/[^/]+$/, '') || '/';
    const tar = tarFile(filePath.slice(dir.length + 1), contents, mode);
    await this.request(
      'PUT',
      `/containers/${encodeURIComponent(container)}/archive?path=${encodeURIComponent(dir)}`,
      tar,
      { raw: true, contentType: 'application/x-tar' },
    );
  }
}

function tenantDockerFromEnv() {
  const host = String(process.env.TENANT_DOCKER_HOST || '').trim();
  if (!host) return null;
  return new TenantDocker(host);
}

module.exports = { TenantDocker, tenantDockerFromEnv, tarFile };
