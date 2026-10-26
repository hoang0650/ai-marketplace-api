/**
 * Dedicated game servers: each buyer session launches its own RunPod pod (CPU when the game
 * allows it) from the product's `gameServer` template, exposes one raw TCP port through
 * RunPod's public-IP mapping, bills per minute at (pod cost + disk) × (1 + markup) from the
 * moment the server answers, and terminates the pod when the session stops.
 */
const net = require('net');
const GameSession = require('../models/GameSession');
const GpuServer = require('../models/GpuServer');
const provider = require('./gpu-rental/provider');
const { gpuRentalConfig } = require('./gpu-rental/config');
const { HOURS_PER_MONTH } = require('./gpu-rental/pricing');
const { PUBLIC_REGION } = require('./white-label');

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
}

function hostingConfig() {
  return {
    /** Give up (no charge, pod terminated) when the server never answers within this window. */
    launchTimeoutMs: Math.max(120_000, num('GAME_SERVER_LAUNCH_TIMEOUT_MS', 12 * 60_000)),
    probeTimeoutMs: Math.max(1000, num('GAME_SERVER_PROBE_TIMEOUT_MS', 4000)),
    markup: gpuRentalConfig().markup,
    storageRunningGbMonth: gpuRentalConfig().storageRunningGbMonth,
  };
}

function isDedicatedProduct(product) {
  const gs = product?.gameServer;
  return Boolean(gs && gs.image && Number(gs.port) > 0);
}

function gameServerSpec(product) {
  const gs = product.gameServer || {};
  const computeType = String(gs.computeType || 'CPU').toUpperCase() === 'GPU' ? 'GPU' : 'CPU';
  return {
    game: String(gs.game || product.slug),
    image: String(gs.image),
    port: Number(gs.port),
    protocol: String(gs.protocol || 'tcp'),
    computeType,
    cpuFlavorIds: Array.isArray(gs.cpuFlavorIds) && gs.cpuFlavorIds.length ? gs.cpuFlavorIds : ['cpu3g', 'cpu5g'],
    vcpuCount: Math.max(2, Number(gs.vcpuCount) || 2),
    gpuTypeIds: Array.isArray(gs.gpuTypeIds) ? gs.gpuTypeIds : undefined,
    diskGb: Math.max(5, Number(gs.diskGb) || 10),
    env: gs.env && typeof gs.env === 'object' ? gs.env : {},
    dataCenterIds: Array.isArray(gs.dataCenterIds) && gs.dataCenterIds.length ? gs.dataCenterIds : undefined,
    dockerStartCmd: Array.isArray(gs.dockerStartCmd) && gs.dockerStartCmd.length ? gs.dockerStartCmd : undefined,
  };
}

/** Buyer USD/hour for a pod: (upstream pod cost + running disk) × (1 + markup), same basis as GPU rental. */
function dedicatedRatePerHour(podCostPerHour, diskGb, cfg = hostingConfig()) {
  const storage = ((Number(diskGb) || 0) * cfg.storageRunningGbMonth) / HOURS_PER_MONTH;
  const base = Math.max(0, Number(podCostPerHour) || 0) + storage;
  return Math.round(base * (1 + cfg.markup) * 1e6) / 1e6;
}

/** Can we open a TCP connection to host:port? (the game is listening and RunPod routes it) */
function probeTcp(host, port, timeoutMs = hostingConfig().probeTimeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function launchDedicatedServer({ product, user, sessionId, client, device }) {
  const spec = gameServerSpec(product);
  const created = await provider.createServer({
    name: `aim-${spec.game}-${sessionId.slice(-8)}`.slice(0, 120),
    kind: 'game',
    image: spec.image,
    ports: `${spec.port}/tcp`,
    computeType: spec.computeType,
    cpuFlavorIds: spec.computeType === 'CPU' ? spec.cpuFlavorIds : undefined,
    vcpuCount: spec.computeType === 'CPU' ? spec.vcpuCount : undefined,
    gpuTypeIds: spec.computeType === 'GPU' ? spec.gpuTypeIds : undefined,
    diskGb: spec.diskGb,
    volumeGb: 0,
    env: spec.env,
    dataCenterIds: spec.dataCenterIds,
    dockerStartCmd: spec.dockerStartCmd,
  });
  if (!created?.id) {
    const err = new Error('Game server could not be launched');
    err.status = 502;
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  try {
    const node = await GpuServer.create({
      owner: product.creator,
      projectId: 'game-server',
      name: `${product.name} · ${sessionId.slice(-6)}`.slice(0, 120),
      provider: gpuRentalConfig().provider,
      providerServerId: created.id,
      kind: 'game',
      status: 'creating',
      gpu: spec.computeType === 'CPU' ? `CPU ${spec.vcpuCount} vCPU` : '',
      product: null,
      external: false,
      devices: ['pc', 'mobile'],
      region: PUBLIC_REGION,
      maxConcurrent: 1,
    });
    const now = new Date();
    const doc = await GameSession.create({
      sessionId,
      user: user._id,
      projectId: 'game-server',
      server: node._id,
      product: product._id,
      seller: product.creator,
      provider: node.provider,
      providerServerId: created.id,
      status: 'starting',
      streamKind: 'tcp',
      client,
      device,
      hosting: 'aimarkets',
      lastActivityAt: now,
      dedicated: true,
      game: spec.game,
      privatePort: spec.port,
      podCostPerHour: Number(created.costPerHour) || 0,
      ratePerHour: dedicatedRatePerHour(created.costPerHour, spec.diskGb),
    });
    return doc;
  } catch (err) {
    await provider.terminateServer(created.id).catch(() => {});
    throw err;
  }
}

/** Pod gone (stop / failed launch). Safe to call repeatedly; the reaper retries failures. */
async function teardownDedicated(session) {
  if (!session?.dedicated || session.podTerminatedAt) return true;
  try {
    await provider.terminateServer(session.providerServerId);
  } catch (err) {
    if (err.code !== 'SERVER_NOT_FOUND') {
      console.error('[game-hosting] terminate failed', session.sessionId, err.code || err.message);
      return false;
    }
  }
  const now = new Date();
  session.podTerminatedAt = now;
  await GameSession.updateOne({ _id: session._id }, { $set: { podTerminatedAt: now } });
  await GpuServer.updateOne({ _id: session.server }, { $set: { status: 'terminated' } });
  return true;
}

/**
 * Move a starting session to live once the game port answers from the internet.
 * Billing starts at that moment. Fails (no charge) after the launch timeout.
 */
async function refreshDedicated(session, { stop } = {}) {
  if (!session?.dedicated || session.status !== 'starting') return session;
  const cfg = hostingConfig();
  let endpoint = null;
  try {
    endpoint = await provider.tcpEndpoint(session.providerServerId, session.privatePort);
  } catch (err) {
    if (err.code === 'SERVER_NOT_FOUND') endpoint = null;
    else throw err;
  }
  if (endpoint && (await module.exports.probeTcp(endpoint.host, endpoint.port))) {
    const now = new Date();
    const live = await GameSession.findOneAndUpdate(
      { _id: session._id, status: 'starting' },
      {
        $set: {
          status: 'live',
          readyAt: now,
          billingStartedAt: now,
          billedUntil: now,
          lastActivityAt: now,
          connectHost: endpoint.host,
          connectPort: endpoint.port,
        },
      },
      { new: true }
    );
    if (live) {
      await GpuServer.updateOne({ _id: session.server }, { $set: { status: 'running' } });
      return live;
    }
    return (await GameSession.findById(session._id)) || session;
  }
  if (Date.now() - new Date(session.createdAt).getTime() > cfg.launchTimeoutMs && stop) {
    session.launchError = 'SERVER_DID_NOT_ANSWER';
    await GameSession.updateOne({ _id: session._id }, { $set: { launchError: session.launchError } });
    await stop(session, 'launch_failed');
  }
  return session;
}

/** Retry teardown for stopped dedicated sessions whose pod could not be terminated. */
async function reapDedicated() {
  const rows = await GameSession.find({
    dedicated: true,
    status: { $in: ['stopped', 'error'] },
    podTerminatedAt: null,
  }).limit(50);
  let reaped = 0;
  for (const s of rows) if (await teardownDedicated(s)) reaped += 1;
  return reaped;
}

module.exports = {
  hostingConfig,
  isDedicatedProduct,
  gameServerSpec,
  dedicatedRatePerHour,
  probeTcp,
  launchDedicatedServer,
  teardownDedicated,
  refreshDedicated,
  reapDedicated,
};
