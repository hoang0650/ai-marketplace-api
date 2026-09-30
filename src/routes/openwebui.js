const { createRuntimeSsoRouter } = require('./runtime-sso');
const { createByokClaimHandler } = require('./runtime-byok-claim');

/** Active BYOK keys of one buyer, decrypted (same store as OpenClaw BYOK). */
async function loadBuyerKeys(uid) {
  const ProviderApiKey = require('../models/ProviderApiKey');
  const { openSecret } = require('../utils/secret-box');
  const rows = await ProviderApiKey.find({ user: uid, status: 'active' }).select('+secret');
  const keys = [];
  for (const row of rows) {
    try {
      keys.push({ provider: row.provider, apiKey: openSecret(row.secret), baseUrl: row.baseUrl, model: row.model });
    } catch {
      console.warn(`[openwebui-byok] cannot decrypt key user=${uid} provider=${row.provider}`);
    }
  }
  if (rows.length) {
    ProviderApiKey.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { lastUsedAt: new Date() } }).catch(
      () => {}
    );
  }
  return keys;
}

/** Open WebUI: one account per buyer, BYOK synced into that account's Direct Connections — no token fee. */
const router = createRuntimeSsoRouter({
  runtime: 'openwebui',
  label: 'Open WebUI',
  envPrefix: 'OPENWEBUI',
  defaultTemplate: 'https://{userId}.openwebui.aimarkets.vn',
  defaultSsoPath: '/api/v1/aimarkets/sso',
});

router.post(
  '/byok/claim',
  createByokClaimHandler({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', loadKeys: loadBuyerKeys })
);

module.exports = router;
