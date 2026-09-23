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
const GpuServer = require('../models/GpuServer');
const Product = require('../models/Product');
const {
  viewportMeta,
  sandboxGameHtml,
  sandboxTerminalHtml,
  isSandboxLike,
} = require('../terminal/sandbox-players');

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
    playerMode: extra.playerMode || (doc.streamKind === 'terminal' ? 'terminal' : undefined),
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

async function sessionPlayerMode(doc, product, server) {
  const cat = product?.category || '';
  const kind = server?.kind || '';
  if (cat === 'gpu-compute') return 'terminal';
  if (cat === 'game-server') return 'game';
  if (kind === 'game') return 'game';
  if (kind === 'compute' || doc.streamKind === 'terminal') return 'terminal';
  return doc.streamKind === 'sandbox' ? 'game' : 'terminal';
}

router.post('/', authenticate, requireRoles('seller', 'admin', 'buyer'), async (req, res, next) => {
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
      const playerMode = await sessionPlayerMode(reused, product, server);
      return res.json(publicGame(reused, req, { productSlug: product?.slug, hosting: hosting || undefined, playerMode }));
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
    const playerMode = await sessionPlayerMode(doc, product, server);
    res.status(201).json(publicGame(doc, req, { productSlug: product?.slug, hosting: hosting || undefined, playerMode }));
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
    const src = doc.streamPath.startsWith('https://') ? doc.streamPath : `./proxy${path}`;
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
    const server = await GpuServer.findById(doc.server).select('kind name gpu').lean();
    const product = doc.product ? await Product.findById(doc.product).select('category').lean() : null;
    const playerMode = await sessionPlayerMode(doc, product, server);
    if (doc.streamKind === 'iframe' && doc.streamPath) {
      return res.send(livePlayerHtml(doc));
    }
    if (isSandboxLike(doc)) {
      if (playerMode === 'terminal') {
        return res.send(
          sandboxTerminalHtml({
            title: 'GPU terminal',
            gpu: server?.gpu,
            hostname: server?.name,
          }),
        );
      }
      return res.send(sandboxGameHtml('Game stream'));
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
