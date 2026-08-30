const http = require('http');
const https = require('https');
const { WebSocket, WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const User = require('../models/User');
const GameSession = require('../models/GameSession');

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
]);

function tokenFromRequest(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  let token = url.searchParams.get('access_token') || '';
  if (!token) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) token = header.slice(7).trim();
  }
  if (!token) {
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)phai_gs=([^;]+)/);
    if (m) {
      try {
        token = decodeURIComponent(m[1]);
      } catch {
        token = m[1];
      }
    }
  }
  return token;
}

function upstreamPath(req, session) {
  const pathOnly = String(req.originalUrl || req.url || '').split('?')[0];
  const prefix = `/v1/game-sessions/${session.sessionId}/proxy`;
  let rest = pathOnly.startsWith(prefix) ? pathOnly.slice(prefix.length) : '';
  if (!rest || rest === '/') rest = session.streamPath || '/';
  if (!rest.startsWith('/')) rest = `/${rest}`;
  const qs = String(req.url || '').includes('?') ? String(req.url).slice(String(req.url).indexOf('?')) : '';
  const cleaned = qs
    .replace(/^\?/, '')
    .split('&')
    .filter((p) => p && !p.startsWith('access_token='))
    .join('&');
  return cleaned ? `${rest}?${cleaned}` : rest;
}

function filterReqHeaders(headers) {
  const out = {};
  Object.entries(headers || {}).forEach(([k, v]) => {
    if (!k || DROP_REQ.has(k.toLowerCase())) return;
    out[k] = v;
  });
  return out;
}

function proxyPrefix(session) {
  return `/v1/game-sessions/${session.sessionId}/proxy`;
}

function rewriteLocation(value, session) {
  if (!value || !session.streamHost) return value;
  const host = String(session.streamHost);
  const port = String(session.streamPort);
  let next = String(value);
  next = next.replace(new RegExp(`https?://${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::${port})?`, 'ig'), proxyPrefix(session));
  if (next.startsWith('/') && !next.startsWith(proxyPrefix(session))) {
    next = `${proxyPrefix(session)}${next}`;
  }
  return next;
}

/**
 * Reverse-proxy HTTP to the pod public port. Host/IP never returned in JSON errors.
 */
function proxyToStream(session, req, res) {
  if (!session.streamHost || !session.streamPort) {
    return res.status(409).json({ message: 'SERVER_NOT_READY', code: 'SERVER_NOT_READY' });
  }
  const path = upstreamPath(req, session);
  const lib = session.streamTls ? https : http;
  const proxyReq = lib.request(
    {
      hostname: session.streamHost,
      port: session.streamPort,
      path,
      method: req.method,
      headers: {
        ...filterReqHeaders(req.headers),
        host: `${session.streamHost}:${session.streamPort}`,
      },
    },
    (proxyRes) => {
      res.status(proxyRes.statusCode || 502);
      Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
        const key = k.toLowerCase();
        if (key === 'set-cookie') return;
        if (key === 'location' || key === 'refresh') {
          res.setHeader(k, rewriteLocation(v, session));
          return;
        }
        res.setHeader(k, v);
      });
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).json({ message: 'Stream unavailable', code: 'PROVIDER_UNAVAILABLE' });
  });
  req.pipe(proxyReq);
}

function setGameCookie(res, sessionId, token) {
  const secure = config.isProduction ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `phai_gs=${encodeURIComponent(token)}; Path=/v1/game-sessions/${sessionId}; HttpOnly; SameSite=Lax; Max-Age=14400${secure}`
  );
}

function attachGameStreamProxy(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/v1\/game-sessions\/([^/]+)\/proxy(.*)$/);
    if (!match) return;

    const sessionId = match[1];
    const destPath = match[2] || '/';
    const token = tokenFromRequest(req);

    (async () => {
      try {
        if (!token) throw new Error('UNAUTHORIZED');
        const payload = jwt.verify(token, config.jwtSecret);
        const user = await User.findById(payload.sub);
        if (!user) throw new Error('UNAUTHORIZED');
        const session = await GameSession.findOne({ sessionId, user: user._id, status: { $in: ['starting', 'live'] } });
        if (!session || !session.streamHost || !session.streamPort) throw new Error('SERVER_NOT_READY');

        wss.handleUpgrade(req, socket, head, (client) => {
          const proto = session.streamTls ? 'wss' : 'ws';
          const qs = [...url.searchParams.entries()]
            .filter(([k]) => k !== 'access_token')
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
          const path = `${destPath || session.streamPath || '/'}${qs ? `?${qs}` : ''}`;
          const upstream = new WebSocket(`${proto}://${session.streamHost}:${session.streamPort}${path.startsWith('/') ? path : `/${path}`}`);
          upstream.on('open', () => {
            client.on('message', (data, isBinary) => {
              if (upstream.readyState === 1) upstream.send(data, { binary: isBinary });
            });
            upstream.on('message', (data, isBinary) => {
              if (client.readyState === 1) client.send(data, { binary: isBinary });
            });
          });
          const closeBoth = () => {
            try {
              client.close();
            } catch (_) {
              /* ignore */
            }
            try {
              upstream.close();
            } catch (_) {
              /* ignore */
            }
          };
          client.on('close', closeBoth);
          upstream.on('close', closeBoth);
          upstream.on('error', closeBoth);
          client.on('error', closeBoth);
        });
      } catch {
        socket.destroy();
      }
    })();
  });

  return wss;
}

module.exports = { proxyToStream, setGameCookie, attachGameStreamProxy, tokenFromRequest };
