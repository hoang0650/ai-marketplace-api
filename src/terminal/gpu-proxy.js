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
      const session = verify(readCookie(req, COOKIE), 'gpu-session', rid);
      if (!session) throw new Error('UNAUTHORIZED');
      const target = await resolveTarget(rid, session.uid);
      const offered = String(req.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const proto = target.tls ? 'wss' : 'ws';
      const portPart = target.port === 443 || target.port === 80 ? '' : `:${target.port}`;
      const upstream = new WebSocket(`${proto}://${target.host}${portPart}${req.url}`, offered, {
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
  rewriteLocation,
  dropResponseHeader,
  _targets: targets,
};
