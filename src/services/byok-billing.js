/**
 * BYOK vs platform model billing for Hermes and NanoClaw.
 * A buyer key skips the platform model charge. Hosting fees are unchanged.
 * Responses carry a label for the UI and never the key itself.
 */

const KEY_SOURCE_LABELS = Object.freeze({
  buyer: {
    vi: 'Đang dùng: key của bạn',
    en: 'Using: your key',
    zh: '正在使用：你的密钥',
  },
  platform: {
    vi: 'Đang dùng: key AI Markets',
    en: 'Using: AI Markets key',
    zh: '正在使用：AI Markets 密钥',
  },
});

function keySourceLabels(keySource) {
  return KEY_SOURCE_LABELS[keySource === 'buyer' ? 'buyer' : 'platform'];
}

function publicKeySource(source) {
  const keySource = source && source.keySource === 'buyer' ? 'buyer' : 'platform';
  return {
    keySource,
    keySourceLabel: keySourceLabels(keySource),
    provider: keySource === 'buyer' ? String(source.provider || '') : '',
    model: keySource === 'buyer' ? String(source.model || '') : '',
    last4: keySource === 'buyer' ? String(source.last4 || '') : '',
    modelCharge: keySource !== 'buyer',
  };
}

/** Buyer key: do not create a wallet debit. Platform mode: caller charges as before. */
function byokUsageDecision(source) {
  const pub = publicKeySource(source);
  if (pub.keySource !== 'buyer') return { skip: false, ...pub };
  return {
    skip: true,
    success: true,
    charged: 0,
    skipped: true,
    reason: 'byok',
    hostingOnly: true,
    ...pub,
  };
}

/**
 * Load the buyer's agent selection. Missing selection is platform mode.
 * The decrypted key is not returned.
 */
async function resolveKeySource(userId, agent, { AgentProviderSetting, ProviderApiKey }) {
  const setting = await AgentProviderSetting.findOne({ user: userId, agent }).lean();
  if (!setting) return { keySource: 'platform' };
  const key = await ProviderApiKey.findOne({
    user: userId,
    provider: setting.provider,
    status: 'active',
  })
    .select('last4 provider')
    .lean();
  if (!key) return { keySource: 'platform', reason: 'key_missing' };
  return {
    keySource: 'buyer',
    provider: setting.provider,
    model: setting.model,
    last4: key.last4 || '',
  };
}

module.exports = {
  KEY_SOURCE_LABELS,
  keySourceLabels,
  publicKeySource,
  byokUsageDecision,
  resolveKeySource,
};
