const { createRuntimeSsoRouter } = require('./runtime-sso');

/** Open WebUI: one account per buyer, BYOK via Direct Connections — no token fee. */
module.exports = createRuntimeSsoRouter({
  runtime: 'openwebui',
  label: 'Open WebUI',
  envPrefix: 'OPENWEBUI',
  defaultTemplate: 'https://{userId}.openwebui.aimarkets.vn',
  defaultSsoPath: '/api/v1/aimarkets/sso',
});
