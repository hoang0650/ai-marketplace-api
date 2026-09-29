const { createRuntimeSsoRouter } = require('./runtime-sso');

/** Paperclip: one board account per buyer, agents use the buyer's own keys (company secrets) — no token fee. */
module.exports = createRuntimeSsoRouter({
  runtime: 'paperclip',
  label: 'Paperclip',
  envPrefix: 'PAPERCLIP',
  defaultTemplate: 'https://{userId}.paperclip.aimarkets.vn',
  defaultSsoPath: '/api/auth/aimarkets/sso',
});
