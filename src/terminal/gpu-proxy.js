const https = require('https');
const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { JWT_VERIFY } = require('../middleware/auth');
const { assertSafeStreamHost } = require('../utils/safe-http-url');
const GpuRental = require('../models/GpuRental');
const { gpuRentalConfig } = require('../utils/gpu-rental/config');
const provider = require('../utils/gpu-rental/provider');

const PATH_RE = /^\/v1\/gpu\/rentals\/([a-f0-9]{24})\/jupyter(?:\/.*)?$/i;
const COOKIE = 'aim_gpu';
const JUPYTER_PORT = 8888;
const TARGET_TTL_MS = 30_000;
const TERM_TICKET_TTL_S = 60;
const TERM_WS_RE = /^\/v1\/gpu\/rentals\/[a-f0-9]{24}\/jupyter\/terminals\/websocket\/([A-Za-z0-9_-]{1,64})$/i;

const DROP_REQ = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization',
  'cookie',
  'origin',
  'referer',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]);

/** Upstream headers that would reveal the vendor or leak cookies. */
function dropResponseHeader(key) {
  return (
    key === 'set-cookie' ||
    key === 'server' ||
    key === 'via' ||
    key === 'nel' ||
    key === 'report-to' ||
    key === 'alt-svc' ||
    key === 'connection' ||
    key === 'keep-alive' ||
    key === 'transfer-encoding' ||
    key.startsWith('cf-') ||
    key.startsWith('x-runpod') ||
    key.startsWith('x-envoy')
  );
}

function basePath(rid) {
  return `/v1/gpu/rentals/${rid}/jupyter`;
}

function readCookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function verify(token, typ, rid) {
  if (!token) return null;
  try {
    const p = jwt.verify(token, config.jwtSecret, JWT_VERIFY);
    return p && p.typ === typ && p.rid === rid && p.uid ? p : null;
  } catch {
    return null;
  }
}

function sessionCookie(rid, uid) {
  const { sessionTtlS } = gpuRentalConfig();
  const token = jwt.sign({ typ: 'gpu-session', rid, uid }, config.jwtSecret, { expiresIn: sessionTtlS, algorithm: 'HS256' });
  const secure = config.isProduction ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(token)}; Path=${basePath(rid)}; HttpOnly; SameSite=Lax; Max-Age=${sessionTtlS}${secure}`;
}

function stripTicket(rawUrl) {
  const url = new URL(rawUrl, 'http://local');
  url.searchParams.delete('ticket');
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ''}`;
}

// rid -> { at, host, port, tls, token }
const targets = new Map();

async function resolveTarget(rid, uid) {
  const hit = targets.get(rid);
  if (hit && Date.now() - hit.at < TARGET_TTL_MS && hit.uid === uid) return hit;
  const rental = await GpuRental.findOne({ _id: rid, owner: uid }).select('+accessToken');
  if (!rental || rental.status !== 'running' || !rental.providerServerId) {
    targets.delete(rid);
    const err = new Error('SERVER_NOT_READY');
    err.code = rental && rental.status === 'terminated' ? 'RENTAL_TERMINATED' : 'SERVER_NOT_READY';
    throw err;
  }
  const up = await provider.httpUpstream(rental.providerServerId, JUPYTER_PORT);
  const host = String(up.host).toLowerCase();
  const { upstreamHostSuffix } = gpuRentalConfig();
  if (upstreamHostSuffix && !host.endsWith(upstreamHostSuffix)) {
    const err = new Error('UNSAFE_HOST');
    err.code = 'UNSAFE_HOST';
    throw err;
  }
  assertSafeStreamHost(host);
  const target = { at: Date.now(), uid, host, port: up.port, tls: up.tls, token: rental.accessToken };
  targets.set(rid, target);
  return target;
}

function forgetTarget(rid) {
  targets.delete(rid);
}

// Single-use terminal tickets: jti -> expiry (ms).
const usedTermTickets = new Map();

function consumeTermTicket(p) {
  const now = Date.now();
  for (const [k, exp] of usedTermTickets) if (exp < now) usedTermTickets.delete(k);
  if (!p.jti || usedTermTickets.has(p.jti)) return false;
  usedTermTickets.set(p.jti, (p.exp || 0) * 1000 || now + TERM_TICKET_TTL_S * 1000);
  return true;
}

function termTicket(rid, uid, term) {
  const jti = require('crypto').randomBytes(12).toString('hex');
  return jwt.sign({ typ: 'gpu-term', rid, uid, term, jti }, config.jwtSecret, {
    expiresIn: TERM_TICKET_TTL_S,
    algorithm: 'HS256',
  });
}

/** Auth for a terminal WebSocket: single-use ticket bound to rental, user and terminal name. */
function termTicketAuth(rawUrl, rid) {
  const url = new URL(rawUrl, 'http://local');
  const ticket = url.searchParams.get('ticket');
  if (!ticket) return null;
  const m = url.pathname.match(TERM_WS_RE);
  if (!m) return null;
  const p = verify(ticket, 'gpu-term', rid);
  if (!p || p.term !== m[1] || !consumeTermTicket(p)) return null;
  return p;
}

function upstreamJson(target, method, path, body) {
  const lib = target.tls ? https : http;
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const r = lib.request(
      {
        hostname: target.host,
        port: target.port,
        servername: target.tls ? target.host : undefined,
        path,
        method,
        headers: {
          host: target.port === 443 || target.port === 80 ? target.host : `${target.host}:${target.port}`,
          authorization: `token ${target.token}`,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (up) => {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((up.statusCode || 500) >= 300) {
            const err = new Error('UPSTREAM_STATUS');
            err.code = up.statusCode >= 500 || up.statusCode === 404 ? 'SERVER_NOT_READY' : 'PROVIDER_ERROR';
            return reject(err);
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            const err = new Error('UPSTREAM_JSON');
            err.code = 'SERVER_NOT_READY';
            reject(err);
          }
        });
      }
    );
    r.setTimeout(20_000, () => r.destroy(Object.assign(new Error('timeout'), { code: 'SERVER_NOT_READY' })));
    r.on('error', (e) => {
      forgetTarget(target.rid);
      reject(Object.assign(e, { code: e.code === 'SERVER_NOT_READY' ? e.code : 'SERVER_NOT_READY' }));
    });
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * Open a real shell on the rented pod (Jupyter terminal) and return a short-lived WebSocket ticket.
 * The browser connects to wsPath?ticket=… ; the proxy forwards to the pod with the rental token.
 */
async function openTerminal(rid, uid) {
  const target = await resolveTarget(rid, uid);
  target.rid = rid;
  const created = await upstreamJson(target, 'POST', `${basePath(rid)}/api/terminals`, {});
  const term = String(created && created.name ? created.name : '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(term)) {
    const err = new Error('TERMINAL_CONNECTION_FAILED');
    err.code = 'SERVER_NOT_READY';
    throw err;
  }
  return {
    term,
    wsPath: `${basePath(rid)}/terminals/websocket/${term}`,
    ticket: termTicket(rid, uid, term),
    expiresIn: TERM_TICKET_TTL_S,
  };
}

/** Start a server-built training bundle on an existing, owner-verified Jupyter workspace. */
async function launchTraining(rid, uid, { jobId, bootstrapUrl, manifestUrl, token }) {
  if (!/^tj_[a-f0-9]{16}$/.test(jobId)) throw new Error('Invalid training job');
  const target = await resolveTarget(rid, uid);
  const created = await upstreamJson(target, 'POST', `${basePath(rid)}/api/terminals`, {});
  const term = String(created.name || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(term)) throw new Error('Invalid terminal');
  const data = Buffer.from(JSON.stringify({ jobId, bootstrapUrl, manifestUrl, token })).toString('base64');
  const python = [
    'import os,json,base64,urllib.request,subprocess',
    `d=json.loads(base64.b64decode('${data}'))`,
    "root='/workspace/training/'+d['jobId']; aim=root+'/aim'; os.makedirs(aim,exist_ok=True)",
    "urllib.request.urlretrieve(d['bootstrapUrl'],aim+'/bootstrap.py')",
    "env=dict(os.environ,AIM_TRAINING_ROOT=root,AIM_TRAINING_MANIFEST_URL=d['manifestUrl'],AIM_JOB_TOKEN=d['token'])",
    "log=open(aim+'/bootstrap.log','ab')",
    "subprocess.Popen(['python3',aim+'/bootstrap.py'],cwd=root,env=env,stdout=log,stderr=log,start_new_session=True)",
    "print('AIM_STARTED',flush=True)",
  ].join('\n');
  const command = `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(python).toString('base64')}'))"; exit\n`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${target.tls ? 'wss' : 'ws'}://${target.host}:${target.port}${basePath(rid)}/terminals/websocket/${term}`, {
      headers: { Authorization: `token ${target.token}` }, handshakeTimeout: 20000,
    });
    let output = '', done = false;
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); ws.close(); err ? reject(err) : resolve(); };
    const timer = setTimeout(() => finish(Object.assign(new Error('Training launch timed out'), { status: 502, code: 'SERVER_NOT_READY' })), 45000);
    ws.on('open', () => ws.send(JSON.stringify(['stdin', command])));
    ws.on('message', raw => {
      try { const msg = JSON.parse(raw.toString()); if (msg[0] === 'stdout') output = (output + msg[1]).slice(-8000); } catch {}
      // Require a standalone output line: the shell also echoes the submitted command.
      if (/(?:^|[\r\n])AIM_STARTED[\r\n]/.test(output)) finish();
    });
    ws.on('error', () => finish(Object.assign(new Error('Training connection failed'), { status: 502, code: 'SERVER_NOT_READY' })));
    ws.on('close', () => { if (!done) finish(Object.assign(new Error('Training launch failed'), { status: 502, code: 'SERVER_NOT_READY' })); });
  });
}

function upstreamHeaders(req, target) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (!k || DROP_REQ.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out.host = target.port === 443 || target.port === 80 ? target.host : `${target.host}:${target.port}`;
  out.authorization = `token ${target.token}`;
  return out;
}

function rewriteLocation(value, target) {
  const s = String(value || '');
  const esc = target.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return s.replace(new RegExp(`^(?:https?|wss?)://${esc}(?::\\d+)?`, 'i'), '');
}

function page(res, status, title, body, refreshSeconds = 0) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : '';
  res.end(
    `<!doctype html><html><head><meta charset="utf-8">${refresh}<title>${title}</title>` +
      '<style>body{font-family:system-ui,sans-serif;background:#0b0f17;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
      'div{max-width:420px;text-align:center}h1{font-size:18px}p{color:#9ca3af;font-size:14px}</style></head>' +
      `<body><div><h1>${title}</h1><p>${body}</p></div></body></html>`
  );
}

/** Express middleware: HTTP reverse proxy for rented GPU workspaces. Mount before body parsers. */
function gpuWorkspaceProxy() {
  return async function gpuWorkspaceProxyMiddleware(req, res, next) {
    const pathOnly = String(req.url || '').split('?')[0];
    const match = pathOnly.match(PATH_RE);
    if (!match) return next();
    const rid = match[1].toLowerCase();

    const url = new URL(req.url, 'http://local');
    const ticket = url.searchParams.get('ticket');
    if (ticket) {
      const p = verify(ticket, 'gpu-ticket', rid);
      if (!p) return page(res, 401, 'Liên kết đã hết hạn', 'Vui lòng mở lại máy GPU từ trang quản lý.');
      res.statusCode = 302;
      res.setHeader('Set-Cookie', sessionCookie(rid, p.uid));
      res.setHeader('Location', stripTicket(req.url));
      res.setHeader('Cache-Control', 'no-store');
      return res.end();
    }

    const session = verify(readCookie(req, COOKIE), 'gpu-session', rid);
    if (!session) return page(res, 401, 'Phiên đã hết hạn', 'Vui lòng mở lại máy GPU từ trang quản lý.');

    let target;
    try {
      target = await resolveTarget(rid, session.uid);
    } catch (err) {
      if (err.code === 'RENTAL_TERMINATED') return page(res, 410, 'Máy GPU đã bị xóa', 'Máy này không còn tồn tại.');
      if (err.code === 'SERVER_NOT_READY' || err.code === 'SERVER_NOT_FOUND') {
        return page(res, 503, 'Máy GPU đang khởi động', 'Trang sẽ tự tải lại khi máy sẵn sàng.', 5);
      }
      return page(res, 502, 'Không kết nối được máy GPU', 'Vui lòng thử lại sau ít phút.', 10);
    }

    const lib = target.tls ? https : http;
    const upstreamReq = lib.request(
      {
        hostname: target.host,
        port: target.port,
        servername: target.tls ? target.host : undefined,
        path: req.url,
        method: req.method,
        headers: upstreamHeaders(req, target),
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        // Vendor edge answers 502/404 with its own page while the container boots.
        if ((status === 502 || status === 503 || status === 504) && req.method === 'GET' && !/\/api\//.test(pathOnly)) {
          upstreamRes.resume();
          forgetTarget(rid);
          return page(res, 503, 'Máy GPU đang khởi động', 'JupyterLab đang được cài đặt, trang sẽ tự tải lại.', 5);
        }
        res.statusCode = status;
        for (const [k, v] of Object.entries(upstreamRes.headers || {})) {
          const key = k.toLowerCase();
          if (dropResponseHeader(key)) continue;
          res.setHeader(k, key === 'location' || key === 'content-location' ? rewriteLocation(v, target) : v);
        }
        upstreamRes.pipe(res);
      }
    );
    upstreamReq.setTimeout(120_000, () => upstreamReq.destroy(new Error('timeout')));
    upstreamReq.on('error', () => {
      forgetTarget(rid);
      if (!res.headersSent) page(res, 502, 'Không kết nối được máy GPU', 'Vui lòng thử lại sau ít phút.', 10);
      else res.destroy();
    });
    req.pipe(upstreamReq);
    return undefined;
  };
}

/** WebSocket bridge (kernels, terminals) for the same paths. */
function attachGpuWorkspaceProxy(httpServer) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  httpServer.on('upgrade', (req, socket, head) => {
    const pathOnly = String(req.url || '').split('?')[0];
    const match = pathOnly.match(PATH_RE);
    if (!match) return;
    const rid = match[1].toLowerCase();

    (async () => {
      const session = termTicketAuth(req.url, rid) || verify(readCookie(req, COOKIE), 'gpu-session', rid);
      if (!session) throw new Error('UNAUTHORIZED');
      const target = await resolveTarget(rid, session.uid);
      const upstreamPath = stripTicket(req.url);
      const offered = String(req.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const proto = target.tls ? 'wss' : 'ws';
      const portPart = target.port === 443 || target.port === 80 ? '' : `:${target.port}`;
      const upstream = new WebSocket(`${proto}://${target.host}${portPart}${upstreamPath}`, offered, {
        headers: upstreamHeaders(req, target),
        servername: target.tls ? target.host : undefined,
        perMessageDeflate: false,
        handshakeTimeout: 20_000,
      });

      await new Promise((resolve, reject) => {
        upstream.once('open', resolve);
        upstream.once('error', reject);
        upstream.once('unexpected-response', () => reject(new Error('UPSTREAM_REJECTED')));
      });

      const selected = upstream.protocol || '';
      // handleUpgrade reads handleProtocols synchronously, so a per-call override is race-free.
      wss.options.handleProtocols = () => selected || false;
      try {
        wss.handleUpgrade(req, socket, head, onClient);
      } finally {
        wss.options.handleProtocols = null;
      }

      function onClient(client) {
        client.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        upstream.on('message', (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        });
        const closeBoth = () => {
          try {
            client.close();
          } catch {
            /* ignore */
          }
          try {
            upstream.close();
          } catch {
            /* ignore */
          }
        };
        client.on('close', closeBoth);
        upstream.on('close', closeBoth);
        client.on('error', closeBoth);
        upstream.on('error', closeBoth);
      }
    })().catch(() => {
      try {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      } catch {
        /* ignore */
      }
      socket.destroy();
    });
  });

  return wss;
}

module.exports = {
  gpuWorkspaceProxy,
  attachGpuWorkspaceProxy,
  sessionCookie,
  stripTicket,
  openTerminal,
  launchTraining,
  termTicket,
  termTicketAuth,
  rewriteLocation,
  dropResponseHeader,
  _targets: targets,
};
