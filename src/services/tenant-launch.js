const AgentProviderSetting = require('../models/AgentProviderSetting');
const ProviderApiKey = require('../models/ProviderApiKey');
const TenantAgent = require('../models/TenantAgent');
const { openSecret } = require('../utils/secret-box');
const { getByokProvider } = require('../utils/byok-providers');
const { publicKeySource } = require('./byok-billing');
const { tenantDockerFromEnv } = require('./tenant-docker');
const {
  IDLE_MS,
  buyerRuntimeEnabled,
  runtimeMaintenanceBody,
  ensureBuyerContainer,
  stopIdleTenants,
  tenantImage,
  newRuntimeToken,
  hashRuntimeToken,
  redact,
} = require('./tenant-runtime');

function apiPublicUrl() {
  return String(process.env.AIMARKETS_API_HOST || process.env.PUBLIC_API_URL || 'https://api.aimarkets.vn').replace(
    /\/$/,
    '',
  );
}

async function loadBuyerSecret(userId, agentId) {
  const setting = await AgentProviderSetting.findOne({ user: userId, agent: agentId }).lean();
  if (!setting) return null;
  const key = await ProviderApiKey.findOne({
    user: userId,
    provider: setting.provider,
    status: 'active',
  }).select('+secret last4 baseUrl');
  if (!key) {
    const err = new Error('Save and verify your API key before launch.');
    err.status = 409;
    err.code = 'KEY_REQUIRED';
    throw err;
  }
  let apiKey;
  try {
    apiKey = openSecret(key.secret);
  } catch {
    console.warn(`[tenant] cannot decrypt key user=${userId} agent=${agentId} provider=${setting.provider}`);
    const err = new Error('Your API key could not be read. Save it again.');
    err.status = 409;
    err.code = 'KEY_UNREADABLE';
    throw err;
  }
  const spec = getByokProvider(setting.provider);
  return {
    keySource: 'buyer',
    provider: setting.provider,
    model: setting.model,
    baseUrl: key.baseUrl || spec?.openaiBaseUrl || '',
    apiKey,
    last4: key.last4 || apiKey.slice(-4),
  };
}

function mongoRecords() {
  return {
    async upsert(record) {
      await TenantAgent.findOneAndUpdate(
        { user: record.userId, agent: record.agentId },
        {
          $set: {
            containerName: record.containerName,
            volumeName: record.volumeName,
            networkName: record.networkName,
            state: record.state,
            lastActiveAt: record.lastActiveAt,
            keySource: record.keySource,
            provider: record.provider,
            model: record.model,
            last4: record.last4,
            runtimeTokenHash: record.runtimeTokenHash || '',
          },
        },
        { upsert: true, new: true },
      );
    },
    async listRunning() {
      return TenantAgent.find({ state: 'running' }).select('containerName lastActiveAt user agent').lean();
    },
    async markStopped(row) {
      await TenantAgent.updateOne({ _id: row._id }, { $set: { state: 'stopped' } });
    },
  };
}

/**
 * When the buyer-runtime flag is off, launch stays in maintenance.
 * When it is on, start this buyer's container and inject /run/secrets/byok.json.
 * Platform mode injects a per-container runtime token, not the platform provider key.
 */
async function launchTenantRuntime({ userId, agentId, docker = null, log = console.log }) {
  if (!buyerRuntimeEnabled(agentId)) {
    return { ok: false, status: 503, body: runtimeMaintenanceBody(agentId) };
  }
  const client = docker || tenantDockerFromEnv();
  const image = tenantImage(agentId);
  if (!client || !image) {
    return {
      ok: false,
      status: 503,
      body: {
        success: false,
        code: 'TENANT_RUNTIME_UNAVAILABLE',
        message: 'Per-user runtime is enabled but TENANT_DOCKER_HOST or the tenant image is not set.',
      },
    };
  }
  const buyer = await loadBuyerSecret(userId, agentId);
  const apiUrl = apiPublicUrl();
  const secret = buyer || {
    keySource: 'platform',
    provider: 'aimarkets',
    model: '',
    baseUrl: `${apiUrl}/v1/tenant/openai`,
    apiKey: newRuntimeToken(),
  };
  const safeLog = (message) => log(redact(message, [secret.apiKey, buyer?.apiKey]));
  try {
    const started = await ensureBuyerContainer({
      agentId,
      userId,
      secret,
      docker: client,
      image,
      apiUrl,
      log: safeLog,
      records: mongoRecords(),
    });
    ProviderApiKey.updateOne(
      { user: userId, provider: secret.provider, status: 'active' },
      { $set: { lastUsedAt: new Date() } },
    ).catch(() => {});
    return {
      ok: true,
      runtime: {
        container: started.container,
        volume: started.volume,
        network: started.network,
        ...publicKeySource(secret),
      },
    };
  } catch (err) {
    if (err.status) throw err;
    safeLog(`[tenant] start failed ${agentId} ${userId} ${err.code || err.message}`);
    return {
      ok: false,
      status: 503,
      body: {
        success: false,
        code: err.code || 'TENANT_START_FAILED',
        message: 'The per-user runtime could not be started.',
      },
    };
  }
}

async function touchTenantActivity(userId, agentId, now = new Date()) {
  await TenantAgent.updateOne(
    { user: userId, agent: agentId, state: 'running' },
    { $set: { lastActiveAt: now } },
  );
}

let timer = null;

function startTenantIdleSweeper() {
  if (timer) return timer;
  const tick = async () => {
    const docker = tenantDockerFromEnv();
    if (!docker) return;
    try {
      const stopped = await stopIdleTenants({ records: mongoRecords(), docker, idleMs: IDLE_MS });
      if (stopped.length) console.log(`[tenant] stopped idle ${stopped.length}`);
    } catch (err) {
      console.error('[tenant] idle sweep failed', err.message);
    }
  };
  timer = setInterval(tick, 60 * 1000);
  timer.unref?.();
  return timer;
}

function stopTenantIdleSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function findTenantByToken(token) {
  if (!token || token.length < 16) return null;
  const hash = hashRuntimeToken(token);
  const row = await TenantAgent.findOne({ runtimeTokenHash: hash, state: 'running' }).select('+runtimeTokenHash').lean();
  if (!row || row.runtimeTokenHash !== hash) return null;
  return row;
}

module.exports = {
  launchTenantRuntime,
  touchTenantActivity,
  startTenantIdleSweeper,
  stopTenantIdleSweeper,
  findTenantByToken,
  loadBuyerSecret,
};
