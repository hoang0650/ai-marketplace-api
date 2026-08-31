const crypto = require('crypto');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const GpuServer = require('../models/GpuServer');
const UsageEvent = require('../models/UsageEvent');
const UsageStat = require('../models/UsageStat');
const WalletTx = require('../models/WalletTx');
const { PLATFORM_FEE_RATE } = require('../utils/platform');
const { getBalance } = require('../utils/wallet');
const provider = require('../utils/denglish-providers');

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

function streamFromServer(server) {
  if (server.streamHost && server.streamPort) {
    return {
      kind: server.streamKind || (server.kind === 'game' ? 'novnc' : 'sandbox'),
      host: server.streamHost,
      port: Number(server.streamPort),
      path: server.streamPath || '/',
      tls: !!server.streamTls,
    };
  }
  if (server.iframeUrl) {
    return { kind: 'iframe', host: '', port: 0, path: server.iframeUrl, tls: false };
  }
  return { kind: 'sandbox', host: '', port: 0, path: '/', tls: false };
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

async function findExternalNode(product) {
  return GpuServer.findOne({ product: product._id, external: true, status: { $ne: 'offline' } }).sort({ updatedAt: -1 });
}

async function assertBuyerAccess(user, product) {
  const pricing = product.pricing || {};
  if (pricing.model === 'free') return;
  if (pricing.model === 'one-time' || pricing.model === 'subscription') return;
  if (pricing.model === 'usage') {
    const min = Number(pricing.usageRate) > 0 ? Math.max(pricing.usageRate / 60, 0.01) : 0;
    if (min > 0) {
      const balance = await getBalance(user._id);
      if (balance < min) {
        const err = new Error('Insufficient wallet balance for compute session');
        err.status = 402;
        err.code = 'INSUFFICIENT_BALANCE';
        err.body = { balance, minimum: min };
        throw err;
      }
    }
  }
}

async function resolveStreamForSession(server, sessionMeta) {
  if (server.webhookUrl) {
    const data = await callSellerWebhook(server, 'session.start', sessionMeta);
    const fromHook = streamFromWebhook(data);
    if (fromHook) return fromHook;
  }
  if (server.external) return streamFromServer(server);
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

function computeSessionCost(product, minutes) {
  const pricing = product.pricing || {};
  if (pricing.model !== 'usage') return 0;
  const unit = String(pricing.usageUnit || 'hours').toLowerCase();
  const rate = Number(pricing.usageRate) || 0;
  if (!rate || minutes <= 0) return 0;
  let quantity = minutes / 60;
  if (unit.startsWith('min')) quantity = minutes;
  if (unit.startsWith('sec')) quantity = minutes * 60;
  return Math.round(quantity * rate * 1e6) / 1e6;
}

async function finalizeSessionBilling(session, product) {
  if (!product || !session.billingStartedAt || session.billedCost > 0) return 0;
  const ended = session.stoppedAt || new Date();
  const minutes = Math.max(1, Math.ceil((ended - session.billingStartedAt) / 60000));
  session.billedMinutes = minutes;
  const cost = computeSessionCost(product, minutes);
  if (cost <= 0) {
    session.billedCost = 0;
    await session.save();
    return 0;
  }
  const buyerId = session.user;
  const sellerId = product.creator;
  const selfUse = String(buyerId) === String(sellerId);
  if (selfUse) {
    session.billedCost = 0;
    await session.save();
    return 0;
  }
  const balance = await getBalance(buyerId);
  if (balance < cost) {
    session.billedCost = cost;
    await session.save();
    return cost;
  }
  const platformFee = Math.round(cost * PLATFORM_FEE_RATE * 1e6) / 1e6;
  const sellerNet = Math.round((cost - platformFee) * 1e6) / 1e6;
  await WalletTx.create({
    user: buyerId,
    type: 'debit',
    amount: cost,
    currency: 'USD',
    note: `Compute: ${product.name} (${minutes}m)`,
  });
  await WalletTx.create({
    user: sellerId,
    type: 'credit',
    amount: sellerNet,
    currency: 'USD',
    note: `Compute revenue: ${product.name}`,
  });
  await UsageEvent.create({
    product: product._id,
    buyer: buyerId,
    seller: sellerId,
    inputTokens: 0,
    outputTokens: 0,
    cost,
    platformFee,
    sellerNet,
    unit: product.pricing?.usageUnit || 'hours',
    quantity: minutes / 60,
    rawUsage: { minutes, sessionId: session.sessionId },
    source: 'gpu',
    usageType: product.category === 'game-server' ? 'GAME_RUNTIME' : 'GPU_HOUR',
  });
  const day = new Date().toISOString().slice(0, 10);
  await UsageStat.updateOne(
    { creator: sellerId, date: day },
    { $inc: { gpuHours: minutes / 60, requests: 1, revenue: sellerNet } },
    { upsert: true }
  ).catch(() => {});
  session.billedCost = cost;
  await session.save();
  return cost;
}

async function registerExternalNode(user, body) {
  const slug = String(body?.productSlug || '').toLowerCase();
  const product = await resolveProduct(slug);
  if (String(product.creator) !== String(user._id) && user.role !== 'admin') {
    const err = new Error('FORBIDDEN');
    err.status = 403;
    throw err;
  }
  const kind = body?.kind === 'compute' ? 'compute' : 'game';
  const providerServerId = String(body?.nodeId || `ext_${crypto.randomBytes(6).toString('hex')}`).slice(0, 120);
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
    webhookUrl: String(body?.webhookUrl || '').slice(0, 500),
    webhookSecret: String(body?.webhookSecret || '').slice(0, 256),
    streamKind: String(body?.streamKind || '').slice(0, 40),
    streamHost: String(body?.streamHost || '').slice(0, 200),
    streamPort: Number(body?.streamPort || 0),
    streamPath: String(body?.streamPath || '/').slice(0, 200),
    streamTls: !!body?.streamTls,
    iframeUrl: String(body?.iframeUrl || '').slice(0, 500),
    healthUrl: String(body?.healthUrl || '').slice(0, 500),
    region: String(body?.region || '').slice(0, 80),
    maxConcurrent: Math.min(100, Math.max(1, Number(body?.maxConcurrent) || 10)),
  });
  return { product, node: doc };
}

function publicNode(doc, product) {
  return {
    id: doc.id || String(doc._id),
    productSlug: product?.slug,
    productName: product?.name,
    name: doc.name,
    kind: doc.kind,
    provider: doc.provider,
    status: doc.status,
    external: !!doc.external,
    region: doc.region || '',
    webhookUrl: doc.webhookUrl ? true : false,
    hasStream: !!(doc.streamHost && doc.streamPort) || !!doc.webhookUrl || !!doc.iframeUrl,
    maxConcurrent: doc.maxConcurrent,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

module.exports = {
  isComputeCategory,
  resolveProduct,
  findExternalNode,
  assertBuyerAccess,
  resolveStreamForSession,
  finalizeSessionBilling,
  registerExternalNode,
  publicNode,
  callSellerWebhook,
  streamFromServer,
};
