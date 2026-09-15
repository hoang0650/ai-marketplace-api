const express = require('express');
const GameSession = require('../models/GameSession');
const { authenticate, requireRoles } = require('../middleware/auth');
const provider = require('../utils/denglish-providers');
const {
  assertServerOwner,
  newSessionId,
  MAX_GAMES_PER_USER,
  GAME_IDLE_MS,
  audit,
} = require('../terminal/permission.service');
const {
  resolveProduct,
  findComputeNode,
  assertBuyerAccess,
  resolveStreamForSession,
  finalizeSessionBilling,
  callSellerWebhook,
} = require('../utils/compute-session');
const { proxyToStream, setGameCookie } = require('../terminal/stream-proxy');
const { setPlayerFrameHeaders } = require('../utils/frame-ancestors');
const { publicHttps } = require('../utils/proxvn');

const router = express.Router();

function publicGame(doc, req, extra = {}) {
  const base = `${req.protocol}://${req.get('host')}/v1/game-sessions/${doc.sessionId}`;
  const proxied = publicHttps('gs', doc.sessionId);
  return {
    sessionId: doc.sessionId,
    projectId: doc.projectId,
    serverId: String(doc.server),
    productSlug: extra.productSlug,
    hosting: extra.hosting,
    provider: doc.provider,
    status: doc.status,
    streamKind: doc.streamKind,
    playerUrl: `${base}/player`,
    publicUrl: proxied || undefined,
    createdAt: doc.createdAt,
  };
}

async function stopLiveGameSession(doc) {
  if (!doc || doc.status === 'stopped') return doc;
  doc.status = 'stopped';
  doc.stoppedAt = new Date();
  await doc.save();
  const product = doc.product ? await require('../models/Product').findById(doc.product) : null;
  const server = await require('../models/GpuServer').findById(doc.server);
  if (server?.webhookUrl) {
    callSellerWebhook(server, 'session.stop', {
      sessionId: doc.sessionId,
      buyerId: String(doc.user),
      minutes: doc.billedMinutes,
    }).catch(() => {});
  }
  if (product) await finalizeSessionBilling(doc, product);
  return doc;
}

async function expireIdleGameSessions(userId) {
  const cutoff = new Date(Date.now() - GAME_IDLE_MS);
  const idle = await GameSession.find({
    user: userId,
    status: { $in: ['starting', 'live'] },
    lastActivityAt: { $lt: cutoff },
  });
  for (const doc of idle) {
    await stopLiveGameSession(doc);
  }
}

async function reuseLiveSession(userId, productId, serverId) {
  const q = {
    user: userId,
    status: { $in: ['starting', 'live'] },
  };
  if (productId) q.product = productId;
  else if (serverId) q.server = serverId;
  else return null;
  const existing = await GameSession.findOne(q).sort({ lastActivityAt: -1 });
  if (!existing) return null;
  existing.lastActivityAt = new Date();
  existing.status = 'live';
  await existing.save();
  return existing;
}

async function freeOldestGameSlot(userId) {
  const oldest = await GameSession.findOne({
    user: userId,
    status: { $in: ['starting', 'live'] },
  }).sort({ lastActivityAt: 1, createdAt: 1 });
  if (oldest) await stopLiveGameSession(oldest);
}

const viewportMeta =
  '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>';

const sandboxPlayerHtml = (title) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
${viewportMeta}
<meta name="mobile-web-app-capable" content="yes"/>
<title>${title}</title>
<style>
  html,body{margin:0;height:100%;background:#05070d;color:#d7ffe3;font-family:ui-sans-serif,system-ui;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;}
  canvas{display:block;width:100%;height:100%;touch-action:none;}
  .hud{position:absolute;left:12px;top:max(8px,env(safe-area-inset-top));font:600 12px/1.35 ui-monospace,monospace;
    background:rgba(0,0,0,.45);padding:6px 8px;border-radius:8px;border:1px solid #1f3d32;max-width:70vw;pointer-events:none}
  .pad{position:absolute;left:max(12px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom));
    display:grid;grid-template-columns:52px 52px 52px;grid-template-rows:52px 52px 52px;gap:6px;z-index:3}
  .pad b{grid-column:2;width:52px;height:52px;border-radius:14px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff}
  .pad .l{grid-column:1;grid-row:2}.pad .r{grid-column:3;grid-row:2}.pad .u{grid-column:2;grid-row:1}.pad .d{grid-column:2;grid-row:3}
  .pad b:active{background:rgba(61,255,176,.35)}
</style></head>
<body>
<div class="hud">AI Markets · GPU stream<br/>Vuốt / D-pad</div>
<canvas id="c"></canvas>
<div class="pad" id="pad">
  <b class="u" data-k="ArrowUp">▲</b>
  <b class="l" data-k="ArrowLeft">◀</b>
  <b class="r" data-k="ArrowRight">▶</b>
  <b class="d" data-k="ArrowDown">▼</b>
</div>
<script>
const c=document.getElementById('c'),x=c.getContext('2d');
let w,h,t=0,px=120,py=120,vx=0,vy=0;
const keys={};
function resize(){const d=Math.min(window.devicePixelRatio||1,2);w=innerWidth;h=innerHeight;c.width=w*d;c.height=h*d;c.style.width=w+'px';c.style.height=h+'px';x.setTransform(d,0,0,d,0,0);}
addEventListener('resize',resize);resize();
addEventListener('keydown',e=>keys[e.key]=true);
addEventListener('keyup',e=>keys[e.key]=false);
function bind(el,code){
  const on=e=>{e.preventDefault();keys[code]=true}; const off=e=>{e.preventDefault();keys[code]=false};
  el.addEventListener('pointerdown',on,{passive:false});
  el.addEventListener('pointerup',off); el.addEventListener('pointercancel',off); el.addEventListener('pointerleave',off);
}
document.querySelectorAll('#pad [data-k]').forEach(el=>bind(el,el.getAttribute('data-k')));
c.addEventListener('pointerdown',e=>{
  const cx=w/2,cy=h/2;
  keys.ArrowRight=e.clientX>cx+24; keys.ArrowLeft=e.clientX<cx-24;
  keys.ArrowDown=e.clientY>cy+24; keys.ArrowUp=e.clientY<cy-24;
},{passive:true});
c.addEventListener('pointerup',()=>{keys.ArrowRight=keys.ArrowLeft=keys.ArrowDown=keys.ArrowUp=false});
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
    const productSlug = String(req.body?.productSlug || '').toLowerCase();
    const serverId = String(req.body?.serverId || '');
    let server;
    let product = null;
    let hosting = '';

    if (productSlug) {
      product = await resolveProduct(productSlug);
      await assertBuyerAccess(req.user, product);
      const resolved = await findComputeNode(product);
      if (!resolved) {
        return res.status(503).json({
          message:
            'No compute node for this product. Seller must register external node or AI Markets hosted RunPod pod.',
          code: 'NO_COMPUTE_NODE',
        });
      }
      server = resolved.node;
      hosting = resolved.hosting;
      const liveOnNode = await GameSession.countDocuments({
        server: server._id,
        status: { $in: ['starting', 'live'] },
      });
      if (liveOnNode >= (server.maxConcurrent || 10)) {
        return res.status(429).json({ message: 'Compute node at capacity', code: 'CAPACITY' });
      }
    } else {
      if (!serverId) return res.status(400).json({ message: 'serverId or productSlug required', code: 'BAD_REQUEST' });
      server = await assertServerOwner(req.user, serverId);
    }

    await expireIdleGameSessions(req.user._id);

    const reused = await reuseLiveSession(req.user._id, product?._id, server._id);
    if (reused) {
      return res.json(publicGame(reused, req, { productSlug: product?.slug, hosting: hosting || undefined }));
    }

    let open = await GameSession.countDocuments({
      user: req.user._id,
      status: { $in: ['starting', 'live'] },
    });
    if (open >= MAX_GAMES_PER_USER) {
      await freeOldestGameSlot(req.user._id);
      open = await GameSession.countDocuments({
        user: req.user._id,
        status: { $in: ['starting', 'live'] },
      });
    }
    if (open >= MAX_GAMES_PER_USER) {
      return res.status(429).json({
        message: 'Too many live streams. Stop another session and retry.',
        code: 'TOO_MANY_STREAMS',
      });
    }

    const sessionId = newSessionId('gs');
    const stream = await resolveStreamForSession(server, {
      sessionId,
      productSlug: product?.slug,
      buyerId: String(req.user._id),
      buyerEmail: req.user.email || '',
      nodeId: server.providerServerId,
    });

    const doc = await GameSession.create({
      sessionId,
      user: req.user._id,
      projectId,
      server: server._id,
      product: product?._id || server.product || null,
      seller: product?.creator || server.owner,
      provider: server.provider,
      providerServerId: server.providerServerId,
      status: 'live',
      streamKind: stream.kind || 'sandbox',
      streamHost: stream.host || '',
      streamPort: Number(stream.port || 0),
      streamPath: stream.path || '/',
      streamTls: !!stream.tls,
      billingStartedAt: new Date(),
    });
    await audit({
      sessionId,
      user: req.user._id,
      projectId,
      serverId: String(server._id),
      event: 'game_stream_start',
    });
    res.status(201).json(publicGame(doc, req, { productSlug: product?.slug, hosting: hosting || undefined }));
  } catch (e) {
    if (e.status === 402) return res.status(402).json({ message: e.message, ...e.body, code: e.code });
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
    await stopLiveGameSession(doc);
    res.json({ ok: true, billedCost: doc.billedCost || 0 });
  } catch (e) {
    next(e);
  }
});

function livePlayerHtml(doc) {
  const kind = doc.streamKind || 'novnc';
  const path = String(doc.streamPath || '/').replace(/^\/+/, '/');
  const shell = (bodyInner, boot) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
${viewportMeta}
<meta name="mobile-web-app-capable" content="yes"/>
<title>GPU Stream</title>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;touch-action:manipulation;-webkit-user-select:none}
  iframe,video{border:0;width:100%;height:100%;background:#000;display:block}
  video{object-fit:contain}
  .hud{position:absolute;z-index:2;left:10px;top:max(6px,env(safe-area-inset-top));font:600 11px/1.3 ui-monospace,monospace;
    background:rgba(0,0,0,.4);padding:6px 8px;border-radius:8px;pointer-events:none;max-width:62vw}
</style></head>
<body>${bodyInner}<script>${boot}</script></body></html>`;

  if (kind === 'iframe' && doc.streamPath) {
    const src = doc.streamPath.startsWith('http') ? doc.streamPath : `./proxy${path}`;
    return shell(
      '<iframe id="f" title="Stream" allow="fullscreen; autoplay; encrypted-media" allowfullscreen></iframe>',
      `const src=${JSON.stringify(src)};document.getElementById('f').src=src.startsWith('http')?src:src+(location.search||'');`,
    );
  }
  const media =
    kind === 'hls'
      ? '<video id="v" controls autoplay playsinline webkit-playsinline muted></video>'
      : '<iframe id="f" title="GPU stream" allow="fullscreen; autoplay; encrypted-media" allowfullscreen></iframe>';
  return shell(
    `<div class="hud">AI Markets · ${kind}</div>${media}`,
    `const q=location.search||'';
const path=${JSON.stringify(path)};
const src='./proxy'+(path.startsWith('/')?path:'/'+path)+q;
const el=document.getElementById('f')||document.getElementById('v');
if(el.tagName==='VIDEO'){el.src=src;el.play&&el.play().catch(()=>{});} else el.src=src;`,
  );
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
    setPlayerFrameHeaders(res);
    if (doc.streamKind === 'iframe' && doc.streamPath) {
      return res.send(livePlayerHtml(doc));
    }
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
