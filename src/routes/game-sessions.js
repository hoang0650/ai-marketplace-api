const express = require('express');
const GameSession = require('../models/GameSession');
const { authenticate, requireRoles } = require('../middleware/auth');
const provider = require('../utils/denglish-providers');
const {
  assertServerOwner,
  newSessionId,
  MAX_GAMES_PER_USER,
  audit,
} = require('../terminal/permission.service');
const { proxyToStream, setGameCookie } = require('../terminal/stream-proxy');
const { publicHttps } = require('../utils/proxvn');

const router = express.Router();

function publicGame(doc, req) {
  const base = `${req.protocol}://${req.get('host')}/v1/game-sessions/${doc.sessionId}`;
  const proxied = publicHttps('gs', doc.sessionId);
  return {
    sessionId: doc.sessionId,
    projectId: doc.projectId,
    serverId: String(doc.server),
    provider: doc.provider,
    status: doc.status,
    streamKind: doc.streamKind,
    playerUrl: `${base}/player`,
    publicUrl: proxied || undefined,
    createdAt: doc.createdAt,
  };
}

const sandboxPlayerHtml = (title) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
  html,body{margin:0;height:100%;background:#05070d;color:#d7ffe3;font-family:ui-sans-serif,system-ui;}
  canvas{display:block;width:100%;height:100%;}
  .hud{position:absolute;left:12px;top:12px;font:600 13px/1.4 ui-monospace,monospace;
    background:rgba(0,0,0,.45);padding:8px 10px;border-radius:8px;border:1px solid #1f3d32}
</style></head>
<body>
<div class="hud">PH AI Market · GPU game stream (proxied)<br/>WASD / arrows · sandbox until RunPod HTTP port is live</div>
<canvas id="c"></canvas>
<script>
const c=document.getElementById('c'),x=c.getContext('2d');
let w,h,t=0,px=120,py=120,vx=0,vy=0;
const keys={};
function resize(){w=c.width=innerWidth;h=c.height=innerHeight;}
addEventListener('resize',resize);resize();
addEventListener('keydown',e=>keys[e.key]=true);
addEventListener('keyup',e=>keys[e.key]=false);
function loop(){
  t+=1;
  vx+=(keys.ArrowRight||keys.d||keys.D)?0.6:0; vx+=(keys.ArrowLeft||keys.a||keys.A)?-0.6:0;
  vy+=(keys.ArrowDown||keys.s||keys.S)?0.6:0; vy+=(keys.ArrowUp||keys.w||keys.W)?-0.6:0;
  vx*=0.9; vy*=0.9; px=Math.max(20,Math.min(w-20,px+vx)); py=Math.max(20,Math.min(h-20,py+vy));
  x.fillStyle='#071018'; x.fillRect(0,0,w,h);
  for(let i=0;i<40;i++){
    const gx=(i*97+t*1.5)%w, gy=(i*53+t)%h;
    x.fillStyle='rgba(80,255,180,'+(0.08+((i%5)*0.04))+')';
    x.fillRect(gx,gy,2,2);
  }
  x.fillStyle='#3dffb0'; x.beginPath(); x.arc(px,py,14,0,Math.PI*2); x.fill();
  x.strokeStyle='#9fffd4'; x.stroke();
  requestAnimationFrame(loop);
}
loop();
</script>
</body></html>`;

router.post('/', authenticate, requireRoles('creator', 'admin', 'buyer'), async (req, res, next) => {
  try {
    const projectId = String(req.body?.projectId || 'default');
    const serverId = String(req.body?.serverId || '');
    if (!serverId) return res.status(400).json({ message: 'serverId required', code: 'SERVER_NOT_FOUND' });
    const server = await assertServerOwner(req.user, serverId);
    const open = await GameSession.countDocuments({
      user: req.user._id,
      status: { $in: ['starting', 'live'] },
    });
    if (open >= MAX_GAMES_PER_USER) {
      return res.status(429).json({ message: 'Too many live streams', code: 'FORBIDDEN' });
    }
    const conn = await provider.getConnection(server.provider, server.providerServerId);
    const stream = conn?.connection?.stream || {};
    const sessionId = newSessionId('gs');
    const doc = await GameSession.create({
      sessionId,
      user: req.user._id,
      projectId,
      server: server._id,
      provider: server.provider,
      providerServerId: server.providerServerId,
      status: 'live',
      streamKind: stream.kind || 'sandbox',
      streamHost: stream.host || '',
      streamPort: Number(stream.port || 0),
      streamPath: stream.path || '/',
      streamTls: !!stream.tls,
    });
    await audit({
      sessionId,
      user: req.user._id,
      projectId,
      serverId: String(server._id),
      event: 'game_stream_start',
    });
    res.status(201).json(publicGame(doc, req));
  } catch (e) {
    next(e);
  }
});

router.get('/:sessionId', authenticate, async (req, res, next) => {
  try {
    const doc = await GameSession.findOne({ sessionId: req.params.sessionId, user: req.user._id });
    if (!doc) return res.status(404).json({ message: 'SESSION_EXPIRED', code: 'SESSION_EXPIRED' });
    res.json(publicGame(doc, req));
  } catch (e) {
    next(e);
  }
});

router.delete('/:sessionId', authenticate, async (req, res, next) => {
  try {
    const doc = await GameSession.findOne({ sessionId: req.params.sessionId, user: req.user._id });
    if (!doc) return res.status(404).json({ message: 'SESSION_EXPIRED', code: 'SESSION_EXPIRED' });
    doc.status = 'stopped';
    doc.stoppedAt = new Date();
    await doc.save();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

function livePlayerHtml(doc) {
  const kind = doc.streamKind || 'novnc';
  const path = String(doc.streamPath || '/').replace(/^\/+/, '/');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>GPU Game Stream</title>
<style>
  html,body{margin:0;height:100%;background:#05070d;color:#cfe;font-family:ui-sans-serif,system-ui}
  iframe,video{border:0;width:100%;height:100%;background:#000}
  .hud{position:absolute;z-index:2;left:12px;top:12px;font:600 12px/1.4 ui-monospace,monospace;
    background:rgba(0,0,0,.5);padding:8px 10px;border-radius:8px;border:1px solid #244}
</style></head>
<body>
<div class="hud">PH AI Market · live ${kind} · proxied (no RunPod host)</div>
${kind === 'hls'
    ? '<video id="v" controls autoplay playsinline></video>'
    : '<iframe id="f" title="GPU stream" allow="fullscreen; autoplay"></iframe>'}
<script>
const q = location.search || '';
const path = ${JSON.stringify(path)};
const src = './proxy' + (path.startsWith('/') ? path : '/' + path) + q;
const el = document.getElementById('f') || document.getElementById('v');
if (el.tagName === 'VIDEO') el.src = src; else el.src = src;
</script>
</body></html>`;
}

router.get('/:sessionId/player', authenticate, async (req, res, next) => {
  try {
    const doc = await GameSession.findOne({ sessionId: req.params.sessionId, user: req.user._id });
    if (!doc) return res.status(404).type('html').send('SESSION_EXPIRED');
    doc.lastActivityAt = new Date();
    await doc.save();
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : String(req.query?.access_token || '');
    if (token) setGameCookie(res, doc.sessionId, token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (doc.streamKind === 'sandbox' || !doc.streamHost || !doc.streamPort) {
      return res.send(sandboxPlayerHtml('GPU Game Stream'));
    }
    return res.send(livePlayerHtml(doc));
  } catch (e) {
    next(e);
  }
});

router.use('/:sessionId/proxy', authenticate, async (req, res, next) => {
  try {
    const doc = await GameSession.findOne({ sessionId: req.params.sessionId, user: req.user._id });
    if (!doc) return res.status(404).json({ message: 'SESSION_EXPIRED', code: 'SESSION_EXPIRED' });
    return proxyToStream(doc, req, res);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
