const crypto = require('crypto');
const Product = require('../models/Product');
const GpuServer = require('../models/GpuServer');
const { getAvailableBalance } = require('../utils/wallet');
const provider = require('../utils/denglish-providers');
const { assertSafeHttpUrl, assertSafeStreamHost } = require('./safe-http-url');
const { publicProvider, internalProvider, publicNodeId, PUBLIC_REGION } = require('./white-label');
const { deviceNodeFilter, normalizeDevices, nodeDevices } = require('./stream-clients');
const { ratePerHourUsd, toUsd } = require('./usage-pricing');

const COMPUTE_CATEGORIES = new Set(['gpu-compute', 'game-server']);

function isComputeCategory(category) {
  return COMPUTE_CATEGORIES.has(String(category || ''));
}

function signWebhook(secret, body) {
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function callSellerWebhook(server, event, payload) {
  const url = String(server.webhookUrl || '').trim();
  if (!url) return null;
  await assertSafeHttpUrl(url);
  const body = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  });
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'AI-Markets-Compute/1.0',
  };
  if (server.webhookSecret) {
    headers['X-AIM-Signature'] = signWebhook(server.webhookSecret, body);
  }
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const err = new Error(`Seller webhook failed (${res.status})`);
    err.status = 502;
    err.code = 'WEBHOOK_FAILED';
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

function mobileStreamFromServer(server) {
  const m = server.mobileStream || {};
  if (m.host && m.port) {
    return {
      kind: m.kind || server.streamKind || 'novnc',
      host: m.host,
      port: Number(m.port),
      path: m.path || '/',
      tls: !!m.tls,
    };
  }
  if (m.iframeUrl) return { kind: 'iframe', host: '', port: 0, path: m.iframeUrl, tls: false };
  return null;
}

function streamFromServer(server, device = 'pc') {
  if (device === 'mobile') {
    const mobile = mobileStreamFromServer(server);
    if (mobile) return mobile;
  }
  if (server.streamHost && server.streamPort) {
    return {
      kind: server.streamKind || (server.kind === 'game' ? 'novnc' : 'terminal'),
      host: server.streamHost,
      port: Number(server.streamPort),
      path: server.streamPath || '/',
      tls: !!server.streamTls,
    };
  }
  if (server.iframeUrl) {
    return { kind: 'iframe', host: '', port: 0, path: server.iframeUrl, tls: false };
  }
  return {
    kind: server.kind === 'game' ? 'sandbox' : 'terminal',
    host: '',
    port: 0,
    path: '/',
    tls: false,
  };
}

function streamFromWebhook(data) {
  if (!data || typeof data !== 'object') return null;
  const host = String(data.streamHost || data.host || '').trim();
  const port = Number(data.streamPort || data.port || 0);
  if (!host || !port) return null;
  return {
    kind: String(data.streamKind || data.kind || 'novnc'),
    host,
    port,
    path: String(data.streamPath || data.path || '/'),
    tls: !!(data.streamTls ?? data.tls),
  };
}

async function resolveProduct(slug) {
  const product = await Product.findOne({ slug: String(slug || '').toLowerCase(), published: { $ne: false } });
  if (!product) {
    const err = new Error('PRODUCT_NOT_FOUND');
    err.status = 404;
    err.code = 'PRODUCT_NOT_FOUND';
    throw err;
  }
  if (!isComputeCategory(product.category)) {
    const err = new Error('Product is not a GPU/game compute listing');
    err.status = 400;
    err.code = 'NOT_COMPUTE_PRODUCT';
    throw err;
  }
  return product;
}

function withDevice(query, device) {
  return device ? { $and: [query, deviceNodeFilter(device)] } : query;
}

async function findExternalNode(product, device) {
  return GpuServer.findOne(
    withDevice({ product: product._id, external: true, status: { $ne: 'offline' } }, device)
  ).sort({ updatedAt: -1 });
}

async function findHostedNode(product, device) {
  return GpuServer.findOne(
    withDevice(
      {
        product: product._id,
        external: false,
        provider: { $nin: ['external', ''] },
        status: { $nin: ['offline', 'terminated'] },
      },
      device
    )
  ).sort({ updatedAt: -1 });
}

const HOSTED_RUNNING = new Set(['running', 'online']);
const HOSTED_STOPPED = new Set(['stopped', 'exited']);

function isPlatformListing(product) {
  return (product?.ownershipType || 'THIRD_PARTY_SELLER') === 'PLATFORM_DIRECT';
}

/**
 * Two supply flows share one catalog/play page:
 *  - PLATFORM_DIRECT: platform-paid RunPod pod first (hosted), external/demo node as fallback.
 *  - THIRD_PARTY_SELLER: seller's own machine (external) first, AI Markets hosted pod as fallback.
 * Only nodes that serve the buyer's device (pc / mobile) are considered.
 */
async function findComputeNode(product, { device } = {}) {
  const order = isPlatformListing(product) ? ['aimarkets', 'external'] : ['external', 'aimarkets'];
  for (const hosting of order) {
    const node = hosting === 'external' ? await findExternalNode(product, device) : await findHostedNode(product, device);
    if (!node) continue;
    if (hosting === 'aimarkets') await ensureHostedNodeReady(node);
    return { node, hosting };
  }
  return null;
}

/** Product devices = union of devices served by its live nodes (unchanged when it has none). */
async function syncProductDevices(productId) {
  if (!productId) return null;
  const nodes = await GpuServer.find({ product: productId, status: { $nin: ['offline', 'terminated'] } })
    .select('devices')
    .lean();
  if (!nodes.length) return null;
  const devices = normalizeDevices(nodes.flatMap((n) => nodeDevices(n)));
  await Product.updateOne({ _id: productId }, { $set: { 'streaming.devices': devices } });
  return devices;
}

async function ensureHostedNodeReady(server) {
  if (server.external || server.provider === 'external') return server;

  let live = {};
  try {
    const remote = await provider.getProviderServer(server.provider, server.providerServerId);
    live = remote.server || {};
  } catch (_) {
    /* keep local status */
  }

  let status = String(live.status || server.status || '').toLowerCase();

  if (HOSTED_STOPPED.has(status)) {
    const started = await provider.startProviderServer(server.provider, server.providerServerId);
    live = started?.server || live;
    status = String(live.status || 'starting').toLowerCase();
    server.status = status;
    await server.save();
  }

  if (!HOSTED_RUNNING.has(status)) {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const remote = await provider.getProviderServer(server.provider, server.providerServerId);
        live = remote.server || {};
        status = String(live.status || status).toLowerCase();
        if (HOSTED_RUNNING.has(status)) break;
      } catch (_) {
        /* retry */
      }
    }
    server.status = status;
    if (live.gpu) server.gpu = String(live.gpu).slice(0, 120);
    await server.save();
  }

  if (!HOSTED_RUNNING.has(status)) {
    const err = new Error('AI Markets hosted GPU pod is not ready yet — try again in a minute');
    err.status = 503;
    err.code = 'HOSTED_POD_NOT_READY';
    throw err;
  }

  return server;
}

/** USD per hour of streaming for usage-priced listings (0 otherwise). */
function usageRatePerHour(product) {
  const pricing = product?.pricing || {};
  if (pricing.model !== 'usage') return 0;
  const rate = Number(pricing.usageRate) || 0;
  if (rate <= 0) return 0;
  // "phút", "per minute", "/min", "1 minute", "sec", "GPU hour"… and VND listings → USD/hour.
  const perHour = ratePerHourUsd(rate, pricing.usageUnit || 'hour', pricing.currency || 'USD');
  return perHour === null ? toUsd(rate, pricing.currency || 'USD') : perHour;
}

async function assertBuyerAccess(user, product) {
  const pricing = product.pricing || {};
  if (pricing.model === 'free') return;
  if (pricing.model === 'one-time' || pricing.model === 'subscription') return;
  if (pricing.model === 'usage') {
    const perHour = usageRatePerHour(product);
    const min = perHour > 0 ? Math.max(perHour / 60, 0.01) : 0;
    if (min > 0 && String(product.creator) !== String(user._id)) {
      const { available, balance, held } = await getAvailableBalance(user._id);
      if (available < min) {
        const err = new Error('Insufficient available wallet balance for compute session');
        err.status = 402;
        err.code = held > 0 ? 'PAYOUT_HELD' : 'INSUFFICIENT_BALANCE';
        err.body = { balance, available, held, minimum: min };
        throw err;
      }
    }
  }
}

/**
 * sessionMeta carries `client` (pc|android|ios), `device` (pc|mobile) and `profile`
 * (resolution / fps / bitrate / inputs) so seller webhooks can start the matching build.
 */
async function resolveStreamForSession(server, sessionMeta) {
  const device = sessionMeta?.device || 'pc';
  if (server.webhookUrl) {
    const data = await callSellerWebhook(server, 'session.start', sessionMeta);
    const fromHook = streamFromWebhook(data);
    if (fromHook) return fromHook;
  }
  if (server.external) return streamFromServer(server, device);
  const conn = await provider.getConnection(server.provider, server.providerServerId);
  const stream = conn?.connection?.stream || {};
  return {
    kind: stream.kind || 'sandbox',
    host: stream.host || '',
    port: Number(stream.port || 0),
    path: stream.path || '/',
    tls: !!stream.tls,
  };
}

async function assertProductOwner(user, product) {
  if (String(product.creator) !== String(user._id) && user.role !== 'admin') {
    const err = new Error('FORBIDDEN');
    err.status = 403;
    throw err;
  }
}

/** Validated `mobileStream` override (same rules as the main stream fields). */
async function parseMobileStream(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const iframeUrl = String(m.iframeUrl || '').trim().slice(0, 500);
  if (iframeUrl) await assertSafeHttpUrl(iframeUrl, { httpsOnly: true });
  return {
    kind: String(m.kind || m.streamKind || '').slice(0, 40),
    host: assertSafeStreamHost(String(m.host || m.streamHost || '').trim().slice(0, 200)),
    port: Math.max(0, Math.min(65535, Number(m.port || m.streamPort) || 0)),
    path: String(m.path || m.streamPath || '').slice(0, 200),
    tls: !!(m.tls ?? m.streamTls),
    iframeUrl,
  };
}

async function registerExternalNode(user, body) {
  const slug = String(body?.productSlug || '').toLowerCase();
  const product = await resolveProduct(slug);
  await assertProductOwner(user, product);
  const mobileStream = await parseMobileStream(body?.mobileStream);
  const kind = body?.kind === 'compute' ? 'compute' : 'game';
  const providerServerId = String(body?.nodeId || `ext_${crypto.randomBytes(6).toString('hex')}`).slice(0, 120);
  const webhookUrl = String(body?.webhookUrl || '').slice(0, 500);
  const healthUrl = String(body?.healthUrl || '').slice(0, 500);
  const iframeUrl = String(body?.iframeUrl || '').slice(0, 500);
  if (webhookUrl) await assertSafeHttpUrl(webhookUrl, { httpsOnly: true });
  if (healthUrl) await assertSafeHttpUrl(healthUrl);
  if (iframeUrl) await assertSafeHttpUrl(iframeUrl, { httpsOnly: true });
  const webhookSecret = String(body?.webhookSecret || '').trim();
  if (webhookSecret && webhookSecret.length < 16) {
    const err = new Error('Webhook secret must be at least 16 characters');
    err.status = 400;
    err.code = 'WEBHOOK_SECRET_TOO_SHORT';
    throw err;
  }
  const hasStaticStream = Boolean(String(body?.streamHost || '').trim() && Number(body?.streamPort) > 0);
  if (!webhookUrl && !hasStaticStream && !iframeUrl) {
    const err = new Error('An external node needs a webhook URL, a stream host + port, or an iframe URL');
    err.status = 400;
    err.code = 'NODE_TARGET_REQUIRED';
    throw err;
  }
  const doc = await GpuServer.create({
    owner: user._id,
    projectId: String(body?.projectId || 'marketplace'),
    name: String(body?.name || product.name).slice(0, 120),
    provider: 'external',
    providerServerId,
    kind,
    status: body?.status === 'offline' ? 'offline' : 'online',
    gpu: String(body?.gpu || '').slice(0, 120),
    product: product._id,
    external: true,
    webhookUrl,
    webhookSecret: webhookSecret.slice(0, 256),
    streamKind: String(body?.streamKind || '').slice(0, 40),
    streamHost: assertSafeStreamHost(String(body?.streamHost || '').slice(0, 200)),
    streamPort: Number(body?.streamPort || 0),
    streamPath: String(body?.streamPath || '/').slice(0, 200),
    streamTls: !!body?.streamTls,
    iframeUrl,
    healthUrl,
    mobileStream,
    devices: normalizeDevices(body?.devices),
    region: String(body?.region || '').slice(0, 80),
    maxConcurrent: Math.min(100, Math.max(1, Number(body?.maxConcurrent) || 10)),
  });
  await syncProductDevices(product._id);
  return { product, node: doc };
}

/** Provision RunPod Pod via denglish-api (ai.aimarkets.vn) and link to marketplace product. */
async function registerHostedNode(user, body) {
  const slug = String(body?.productSlug || '').toLowerCase();
  const product = await resolveProduct(slug);
  await assertProductOwner(user, product);
  const kind = body?.kind === 'compute' ? 'compute' : 'game';
  const providerName = internalProvider(body?.provider);
  const created = await provider.createProviderServer(providerName, {
    name: String(body?.name || product.name).slice(0, 120),
    kind,
    gpuType: body?.gpuType || body?.gpu,
    image: body?.image,
    ports: kind === 'game' ? '22/tcp,8080/http,6080/http' : '22/tcp',
  });
  const remote = created.server || {};
  const doc = await GpuServer.create({
    owner: user._id,
    projectId: String(body?.projectId || 'marketplace'),
    name: remote.name || String(body?.name || product.name).slice(0, 120),
    provider: providerName,
    providerServerId: String(remote.id || `pod_${crypto.randomBytes(6).toString('hex')}`).slice(0, 120),
    kind,
    status: remote.status || 'creating',
    gpu: String(remote.gpu || body?.gpuType || '').slice(0, 120),
    product: product._id,
    external: false,
    devices: normalizeDevices(body?.devices),
    region: String(body?.region || PUBLIC_REGION).slice(0, 80),
    maxConcurrent: Math.min(100, Math.max(1, Number(body?.maxConcurrent) || 5)),
  });
  await syncProductDevices(product._id);
  return { product, node: doc };
}

async function registerComputeNode(user, body) {
  const hosting = String(body?.hosting || body?.mode || 'external').toLowerCase();
  if (hosting === 'aimarkets' || hosting === 'hosted' || hosting === 'internal') {
    return registerHostedNode(user, body);
  }
  return registerExternalNode(user, body);
}

/** Owner-only editable settings (never includes the webhook secret itself). */
function sellerNodeConfig(doc) {
  return {
    webhookUrl: doc.webhookUrl || '',
    hasWebhookSecret: Boolean(doc.webhookSecret),
    streamHost: doc.streamHost || '',
    streamPort: doc.streamPort || 0,
    streamPath: doc.streamPath || '',
    streamKind: doc.streamKind || '',
    streamTls: Boolean(doc.streamTls),
    iframeUrl: doc.iframeUrl || '',
    healthUrl: doc.healthUrl || '',
    gpu: doc.gpu || '',
    mobileStream: doc.mobileStream
      ? {
          iframeUrl: doc.mobileStream.iframeUrl || '',
          host: doc.mobileStream.host || '',
          port: doc.mobileStream.port || 0,
          path: doc.mobileStream.path || '',
        }
      : null,
  };
}

function publicNode(doc, product) {
  const hosting = doc.external ? 'external' : doc.product ? 'aimarkets' : 'lab';
  return {
    id: doc.id || String(doc._id),
    productSlug: product?.slug,
    productName: product?.name,
    name: doc.name,
    kind: doc.kind,
    provider: publicProvider(doc.provider),
    status: doc.status,
    external: !!doc.external,
    hosting,
    region: doc.region || '',
    webhookUrl: doc.webhookUrl ? true : false,
    hasStream:
      !!(doc.streamHost && doc.streamPort) ||
      !!doc.webhookUrl ||
      !!doc.iframeUrl ||
      (!doc.external && doc.provider === 'runpod'),
    devices: nodeDevices(doc),
    hasMobileStream: !!(doc.mobileStream?.iframeUrl || (doc.mobileStream?.host && doc.mobileStream?.port)),
    supply: (product?.ownershipType || 'THIRD_PARTY_SELLER') === 'PLATFORM_DIRECT' ? 'platform' : 'seller',
    providerServerId: publicNodeId(doc.provider, doc.providerServerId),
    maxConcurrent: doc.maxConcurrent,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

module.exports = {
  sellerNodeConfig,
  isComputeCategory,
  resolveProduct,
  findExternalNode,
  findHostedNode,
  findComputeNode,
  isPlatformListing,
  syncProductDevices,
  usageRatePerHour,
  ensureHostedNodeReady,
  assertBuyerAccess,
  resolveStreamForSession,
  parseMobileStream,
  registerExternalNode,
  registerHostedNode,
  registerComputeNode,
  publicNode,
  callSellerWebhook,
  streamFromServer,
};
