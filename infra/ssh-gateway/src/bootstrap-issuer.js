/**
 * OpenClaw Control UI bootstrap-token issuer (internal, API-only).
 *
 * OpenClaw can only mint device bootstrap tokens on the gateway host. This tiny
 * HTTP endpoint lets the AI Markets API ask for ONE reduced-scope token for a
 * signed-in buyer:
 *   - HMAC-signed requests (key derived from SSH_GATEWAY_SHARED_SECRET), 60 s
 *     clock skew, single-use nonces;
 *   - the profile is fixed here: role operator, purpose "control-ui", scopes
 *     from SCOPE_ALLOWLIST only (never operator.admin / operator.pairing); the
 *     gateway strips anything outside its own non-admin handoff set as well;
 *   - per-user and global rate limits, one mint at a time;
 *   - tokens are single-use and expire after OpenClaw's bootstrap TTL (10 min);
 *   - never logs tokens, only a short SHA-256 fingerprint for audit.
 * It is not published on a host port: Traefik routes one path to it with an
 * IP allowlist (see traefik-bootstrap-issuer.yml). Docker access stays behind the
 * socket proxy on an internal network.
 */
const http = require('http');
const crypto = require('crypto');
const { verify } = require('./issuer-auth');
const { createDemuxer } = require('./docker');

const SCOPE_ALLOWLIST = Object.freeze([
  'operator.approvals',
  'operator.questions',
  'operator.read',
  'operator.talk.secrets',
  'operator.write',
]);
const FORBIDDEN = new Set(['operator.admin', 'operator.pairing']);
const USER_ID_RE = /^[a-f0-9]{24}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,256}$/;
const PATH = '/v1/openclaw/bootstrap-token';

if (SCOPE_ALLOWLIST.some((s) => FORBIDDEN.has(s))) throw new Error('bootstrap issuer allowlist contains a forbidden scope');

/**
 * Runs inside the OpenClaw gateway container (as the gateway's own user). Finds
 * OpenClaw's issueDeviceBootstrapToken in the bundled dist (file names are
 * hashed per release) and issues a control-ui operator profile. Fails closed.
 */
const MINT_SCRIPT = `
import { readdirSync, readFileSync } from 'node:fs';
const SCOPES = ${JSON.stringify(SCOPE_ALLOWLIST)};
const dir = '/app/dist';
let file = null, alias = null;
for (const f of readdirSync(dir)) {
  if (!/^device-bootstrap-[A-Za-z0-9_-]+\\.mjs$/.test(f)) continue;
  const src = readFileSync(dir + '/' + f, 'utf8');
  if (!src.includes('async function issueDeviceBootstrapToken(')) continue;
  const m = src.match(/issueDeviceBootstrapToken as ([A-Za-z_$][\\w$]*)/);
  if (m) { file = dir + '/' + f; alias = m[1]; break; }
}
if (!file) { console.log(JSON.stringify({ ok: false, error: 'issuer_not_found' })); process.exit(2); }
const mod = await import(file);
const issued = await mod[alias]({ profile: { roles: ['operator'], scopes: SCOPES, purpose: 'control-ui' } });
console.log(JSON.stringify({ ok: true, token: issued.token, expiresAtMs: issued.expiresAtMs }));
process.exit(0);
`;

class WindowLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }
  take(key, now = Date.now()) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

class NonceCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.seen = new Map();
  }
  /** true if new (and records it), false on replay. */
  add(nonce, now = Date.now()) {
    for (const [n, t] of this.seen) if (now - t > this.ttlMs) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    if (this.seen.size > 10_000) return false; // flood guard; fail closed
    this.seen.set(nonce, now);
    return true;
  }
}

/** Mint via docker exec in the OpenClaw gateway container. */
async function mintInGateway(docker, cfg) {
  const id = await docker.findServiceContainer(cfg.openclawService);
  if (!id) throw new Error('openclaw container not found');
  const { stdout, exitCode } = await docker.execCollect(
    id,
    ['node', '--input-type=module', '-e', MINT_SCRIPT],
    { user: cfg.openclawUser, workdir: '/app', timeoutMs: cfg.mintTimeoutMs },
  );
  const line = String(stdout).trim().split('\n').pop() || '';
  let out = null;
  try {
    out = JSON.parse(line);
  } catch {
    out = null;
  }
  if (exitCode !== 0 || !out?.ok || !TOKEN_RE.test(String(out.token || '')) || !Number.isFinite(out.expiresAtMs)) {
    throw new Error(`mint failed (exit ${exitCode}${out?.error ? `, ${out.error}` : ''})`);
  }
  return { token: out.token, expiresAtMs: out.expiresAtMs };
}

function createIssuerHandler({ cfg, mint, log, now = () => Date.now() }) {
  const nonces = new NonceCache(5 * 60_000);
  const perUser = new WindowLimiter(cfg.issuerWindowMs, cfg.issuerPerUserMax);
  const global = new WindowLimiter(cfg.issuerWindowMs, cfg.issuerGlobalMax);
  let chain = Promise.resolve();

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  return (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== PATH) return send(res, 404, { ok: false, error: 'not_found' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024) {
        send(res, 413, { ok: false, error: 'too_large' });
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks).toString('utf8');
      const authErr = verify(cfg.apiSecret, {
        ts: req.headers['x-aim-ts'],
        nonce: req.headers['x-aim-nonce'],
        sig: req.headers['x-aim-sig'],
        body,
        now: now(),
      });
      if (authErr) {
        log('bootstrap_denied', { reason: authErr });
        return send(res, 401, { ok: false, error: 'unauthorized' });
      }
      if (!nonces.add(String(req.headers['x-aim-nonce']), now())) {
        log('bootstrap_denied', { reason: 'replay' });
        return send(res, 401, { ok: false, error: 'unauthorized' });
      }
      let userId = '';
      try {
        userId = String(JSON.parse(body)?.userId || '').toLowerCase();
      } catch {
        userId = '';
      }
      if (!USER_ID_RE.test(userId)) return send(res, 400, { ok: false, error: 'bad_user' });
      if (!perUser.take(userId, now()) || !global.take('*', now())) {
        log('bootstrap_rate_limited', { userId });
        return send(res, 429, { ok: false, error: 'rate_limited' });
      }
      const run = chain.catch(() => {}).then(() => mint());
      chain = run;
      try {
        const { token, expiresAtMs } = await run;
        const fp = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
        log('bootstrap_issued', { userId, fp, expiresAtMs });
        return send(res, 200, { ok: true, token, expiresAtMs, scopes: SCOPE_ALLOWLIST, role: 'operator' });
      } catch (err) {
        log('bootstrap_failed', { userId, error: String(err?.message || err).slice(0, 200) });
        return send(res, 502, { ok: false, error: 'mint_failed' });
      }
    });
  };
}

function startIssuer(deps) {
  const { cfg, docker, log } = deps;
  const handler = createIssuerHandler({ cfg, log, mint: () => mintInGateway(docker, cfg) });
  const server = http.createServer(handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.listen(cfg.issuerPort, '0.0.0.0', () => log('issuer_listening', { port: cfg.issuerPort }));
  return server;
}

module.exports = { startIssuer, createIssuerHandler, mintInGateway, SCOPE_ALLOWLIST, MINT_SCRIPT, PATH, WindowLimiter, NonceCache };
