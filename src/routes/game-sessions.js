const express = require('express');
const GameSession = require('../models/GameSession');
const { authenticate, requireRoles } = require('../middleware/auth');
const provider = require('../utils/denglish-providers');
const { publicProvider } = require('../utils/white-label');
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
} = require('../utils/compute-session');
const {
  HEARTBEAT_MS,
  gameBillingConfig,
  stopGameSession,
  sessionBillingState,
} = require('../utils/game-billing');
const { resolveClient, assertDeviceSupported, streamProfile, productDevices } = require('../utils/stream-clients');
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

const {
  isDedicatedProduct,
  launchDedicatedServer,
  refreshDedicated,
} = require('../utils/game-hosting');

const router = express.Router();

function dedicatedInfo(doc) {
  if (!doc.dedicated) return {};
  const ready = doc.status === 'live' && doc.connectHost && doc.connectPort;
  return {
    dedicated: true,
    game: doc.game || undefined,
    ratePerHour: doc.ratePerHour || 0,
    ratePerMinute: Math.round(((doc.ratePerHour || 0) / 60) * 1e6) / 1e6,
    connect: ready
      ? { host: doc.connectHost, port: doc.connectPort, address: `${doc.connectHost}:${doc.connectPort}` }
      : null,
    readyAt: doc.readyAt || undefined,
    launchError: doc.launchError || undefined,
  };
}

function publicGame(doc, req, extra = {}) {
  const base = `${req.protocol}://${req.get('host')}/v1/game-sessions/${doc.sessionId}`;
  const proxied = publicHttps('gs', doc.sessionId);
  return {
    sessionId: doc.sessionId,
    projectId: doc.projectId,
    serverId: String(doc.server),
    productSlug: extra.productSlug,
    hosting: extra.hosting,
    provider: publicProvider(doc.provider),
    status: doc.status,
    stopReason: doc.stopReason || undefined,
    client: doc.client || 'pc',
    device: doc.device || 'pc',
    profile: streamProfile(doc.device || 'pc'),
    streamKind: doc.streamKind,
    playerMode: extra.playerMode || (doc.streamKind === 'terminal' ? 'terminal' : undefined),
    playerUrl: `${base}/player`,
    publicUrl: proxied || undefined,
    heartbeatMs: HEARTBEAT_MS,
    idleTimeoutMs: gameBillingConfig().idleMs,
    billedMinutes: doc.billedMinutes || 0,
    billedCost: Math.round((doc.billedCost || 0) * 100) / 100,
    createdAt: doc.createdAt,
    ...dedicatedInfo(doc),
  };
}

async function expireIdleGameSessions(userId) {
  const cutoff = new Date(Date.now() - GAME_IDLE_MS);
  const idle = await GameSession.find({
    user: userId,
    status: { $in: ['starting', 'live'] },
    heartbeatAt: { $ne: null },
    lastActivityAt: { $lt: cutoff },
  });
  const dedicatedCutoff = Date.now() - gameBillingConfig().dedicatedIdleMs;
  for (const doc of idle) {
    if (doc.dedicated && new Date(doc.lastActivityAt).getTime() > dedicatedCutoff) continue;
    await stopGameSession(doc, 'idle');
  }
}

/**
 * One seat per buyer per listing: same device → reuse the live stream; the other
 * device (PC ↔ mobile) → stop it first so the buyer is never billed twice.
 */
async function reuseLiveSession(userId, productId, serverId, device) {
  const q = {
    user: userId,
    status: { $in: ['starting', 'live'] },
  };
  if (productId) q.product = productId;
  else if (serverId) q.server = serverId;
  else return null;
  const live = await GameSession.find(q).sort({ lastActivityAt: -1 });
  let existing = null;
  for (const doc of live) {
    if (!existing && (doc.device || 'pc') === device) existing = doc;
    else await stopGameSession(doc, 'switched_device');
  }
  if (!existing) return null;
  existing.lastActivityAt = new Date();
  // A dedicated server only goes live once its port answers (refreshDedicated).
  if (!existing.dedicated) existing.status = 'live';
  await existing.save();
  return existing;
}

async function freeOldestGameSlot(userId) {
  const oldest = await GameSession.findOne({
    user: userId,
    status: { $in: ['starting', 'live'] },
  }).sort({ lastActivityAt: 1, createdAt: 1 });
  if (oldest) await stopGameSession(oldest, 'slot_reclaimed');
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

/** Dedicated game server: one pod per buyer session (see utils/game-hosting). */
async function startDedicated(req, res, product, { client, device }) {
  await expireIdleGameSessions(req.user._id);
  const reused = await reuseLiveSession(req.user._id, product._id, null, device);
  if (reused) {
    const fresh = await refreshDedicated(reused, { stop: (d, r) => stopGameSession(d, r, { product }) });
    return res.json(publicGame(fresh, req, { productSlug: product.slug, hosting: 'aimarkets', playerMode: 'game' }));
  }
  let open = await GameSession.countDocuments({ user: req.user._id, status: { $in: ['starting', 'live'] } });
  if (open >= MAX_GAMES_PER_USER) {
    await freeOldestGameSlot(req.user._id);
    open = await GameSession.countDocuments({ user: req.user._id, status: { $in: ['starting', 'live'] } });
  }
  if (open >= MAX_GAMES_PER_USER) {
    return res.status(429).json({ message: 'Too many live sessions. Stop another session and retry.', code: 'TOO_MANY_STREAMS' });
  }
  const sessionId = newSessionId('gs');
  let doc;
  try {
    doc = await launchDedicatedServer({ product, user: req.user, sessionId, client, device });
  } catch (err) {
    const code = err.code === 'GPU_UNAVAILABLE' ? 'CAPACITY' : err.code || 'PROVIDER_ERROR';
    return res.status(err.status === 409 ? 503 : 502).json({ message: 'Game server could not be launched right now, please retry.', code });
  }
  await audit({
    sessionId,
    user: req.user._id,
    projectId: 'game-server',
    serverId: String(doc.server),
    event: 'game_server_launch',
  });
  return res.status(201).json(publicGame(doc, req, { productSlug: product.slug, hosting: 'aimarkets', playerMode: 'game' }));
}

router.post('/', authenticate, requireRoles('seller', 'admin', 'buyer'), async (req, res, next) => {
  try {
    const projectId = String(req.body?.projectId || 'default');
    const productSlug = String(req.body?.productSlug || '').toLowerCase();
    const serverId = String(req.body?.serverId || '');
    const { client, device } = resolveClient(req.body?.client, req.get('user-agent'));
    let server;
    let product = null;
    let hosting = '';

    if (productSlug) {
      product = await resolveProduct(productSlug);
      assertDeviceSupported(product, device);
      await assertBuyerAccess(req.user, product);
      if (isDedicatedProduct(product)) return startDedicated(req, res, product, { client, device, projectId });
      const resolved = await findComputeNode(product, { device });
      if (!resolved) {
        return res.status(503).json({
          message: `No compute node serves ${device === 'mobile' ? 'the mobile app' : 'PC'} for this product yet.`,
          code: 'NO_COMPUTE_NODE',
          device,
          supportedDevices: productDevices(product),
        });
      }
      server = resolved.node;
      hosting = resolved.hosting;
      const liveOnNode = await GameSession.countDocuments({
        server: server._id,
        user: { $ne: req.user._id },
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

    const reused = await reuseLiveSession(req.user._id, product?._id, server._id, device);
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
      client,
      device,
      profile: streamProfile(device),
    });

    const now = new Date();
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
      client,
      device,
      hosting,
      lastActivityAt: now,
      billingStartedAt: now,
      billedUntil: now,
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
    if (e.status === 402 || e.code === 'CLIENT_NOT_SUPPORTED') {
      return res.status(e.status).json({ message: e.message, ...e.body, code: e.code });
    }
    next(e);
  }
});

/** Client keep-alive (every `heartbeatMs`); also returns the running bill and minutes left. */
router.post('/:sessionId/heartbeat', authenticate, async (req, res, next) => {
  try {
    const doc = await GameSession.findOne({ sessionId: req.params.sessionId, user: req.user._id });
    if (!doc) return res.status(404).json({ message: 'SESSION_EXPIRED', code: 'SESSION_EXPIRED' });
    const product = doc.product ? await Product.findById(doc.product).lean() : null;
    if (doc.status === 'stopped' || doc.status === 'error') {
      return res.status(410).json({
        message: 'SESSION_STOPPED',
        code: 'SESSION_STOPPED',
        stopReason: doc.stopReason || 'user',
        ...(await sessionBillingState(doc, product)),
      });
    }
    const now = new Date();
    await GameSession.updateOne(
      { _id: doc._id, status: { $in: ['starting', 'live'] } },
      { $set: doc.dedicated ? { lastActivityAt: now, heartbeatAt: now } : { lastActivityAt: now, heartbeatAt: now, status: 'live' } }
    );
    res.json({
      ok: true,
      status: doc.dedicated ? doc.status : 'live',
      device: doc.device || 'pc',
      heartbeatMs: HEARTBEAT_MS,
      ...(await sessionBillingState(doc, product)),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/:sessionId', authenticate, async (req, res, next) => {
  try {
    let doc = await GameSession.findOne({ sessionId: req.params.sessionId, user: req.user._id });
    if (!doc) return res.status(404).json({ message: 'SESSION_EXPIRED', code: 'SESSION_EXPIRED' });
    if (doc.dedicated && doc.status === 'starting') {
      const product = doc.product ? await Product.findById(doc.product).lean() : null;
      doc = await refreshDedicated(doc, { stop: (d, r) => stopGameSession(d, r, { product }) });
    }
    res.json(publicGame(doc, req));
  } catch (e) {
    next(e);
  }
});

router.delete('/:sessionId', authenticate, async (req, res, next) => {
  try {
    const doc = await GameSession.findOne({ sessionId: req.params.sessionId, user: req.user._id });
    if (!doc) return res.status(404).json({ message: 'SESSION_EXPIRED', code: 'SESSION_EXPIRED' });
    await stopGameSession(doc, 'user');
    res.json({ ok: true, billedCost: doc.billedCost || 0, billedMinutes: doc.billedMinutes || 0 });
  } catch (e) {
    next(e);
  }
});

/**
 * Default upstream query per device. noVNC: PC keeps native resolution + best quality;
 * mobile scales to the screen with stronger compression for cellular links.
 */
function profileQuery(kind, device) {
  const base = { aim_client: device };
  if (kind !== 'novnc') return base;
  return device === 'mobile'
    ? { ...base, autoconnect: '1', resize: 'scale', quality: '5', compression: '6', show_dot: 'true' }
    : { ...base, autoconnect: '1', resize: 'remote', quality: '9', compression: '2' };
}

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
  const device = doc.device === 'mobile' ? 'mobile' : 'pc';
  return shell(
    `<div class="hud">AI Markets · ${kind} · ${device === 'mobile' ? 'Mobile' : 'PC'}</div>${media}`,
    `const p=new URLSearchParams(${JSON.stringify(profileQuery(kind, device))});
new URLSearchParams(location.search).forEach((v,k)=>p.set(k,v));
const q=p.toString()?'?'+p.toString():'';
const path=${JSON.stringify(path)};
const src='./proxy'+(path.startsWith('/')?path:'/'+path)+q;
const el=document.getElementById('f')||document.getElementById('v');
if(el.tagName==='VIDEO'){el.src=src;el.play&&el.play().catch(()=>{});} else el.src=src;`,
  );
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Status / address card for a dedicated game server (the buyer plays in their own game client). */
function dedicatedServerHtml(product) {
  const name = esc(product?.name || 'Game server');
  const hint = esc(product?.gameServer?.connectHint || '');
  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"/>${viewportMeta}<title>${name}</title>
<style>
  html,body{margin:0;height:100%;background:#0b0f17;color:#e8edf5;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:560px;margin:0 auto;padding:28px 20px}
  h1{font-size:20px;margin:0 0 6px} .muted{color:#93a0b4;font-size:13px}
  .card{background:#131a26;border:1px solid #24304a;border-radius:14px;padding:18px;margin-top:16px}
  .addr{font:600 22px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
  button{margin-top:10px;background:#e8463a;color:#fff;border:0;border-radius:10px;padding:9px 14px;font-weight:600;cursor:pointer}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#f5a524;margin-right:6px}
  .live .dot{background:#22c55e}
</style></head><body><main>
<h1>${name}</h1>
<div class="muted">Máy chủ riêng cho bạn · Dedicated server for you</div>
<div class="card" id="st"><span class="dot"></span><span id="msg">Đang khởi động máy chủ (1–5 phút)… · Starting server (1–5 min)…</span></div>
<div class="card" id="cn" hidden>
  <div class="muted">Địa chỉ máy chủ · Server address</div>
  <div class="addr" id="addr"></div>
  <button type="button" id="cp">Sao chép · Copy</button>
  ${hint ? `<p class="muted">${hint}</p>` : ''}
  <p class="muted">Giữ tab này mở khi đang chơi; đóng tab hoặc bấm Dừng sẽ tắt máy chủ và ngừng tính phí. · Keep this tab open while playing; closing it or pressing Stop shuts the server down and stops billing.</p>
</div>
<div class="card muted" id="bill"></div>
</main><script>
const base=location.pathname.replace(/\\/player$/,'')+location.search;
const $=(id)=>document.getElementById(id);
$('cp').onclick=()=>navigator.clipboard&&navigator.clipboard.writeText($('addr').textContent);
async function poll(){
  try{
    const r=await fetch(base,{credentials:'include'});const s=await r.json();
    if(s.connect){$('st').className='card live';$('msg').textContent='Máy chủ đang chạy · Server is live';$('cn').hidden=false;$('addr').textContent=s.connect.address;}
    else if(s.status==='stopped'||s.status==='error'){$('msg').textContent=s.stopReason==='launch_failed'?'Không khởi động được máy chủ, không tính phí. Vui lòng thử lại. · Launch failed, not billed. Please retry.':'Máy chủ đã dừng · Server stopped';$('cn').hidden=true;return;}
    if(s.ratePerMinute){$('bill').textContent='Phí · Rate: $'+s.ratePerMinute.toFixed(4)+'/phút ($'+(s.ratePerHour||s.ratePerMinute*60).toFixed(3)+'/giờ · hour) · đã tính · billed: $'+(s.billedCost||0).toFixed(2)+' ('+(s.billedMinutes||0)+' phút)';}
  }catch(e){}
  setTimeout(poll,5000);
}
poll();
</script></body></html>`;
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
    if (doc.dedicated) {
      const p = doc.product ? await Product.findById(doc.product).select('name gameServer').lean() : null;
      return res.send(dedicatedServerHtml(p));
    }
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

/** Exposed for tests (inline player script must stay valid JS). */
router.dedicatedServerHtml = dedicatedServerHtml;

module.exports = router;
