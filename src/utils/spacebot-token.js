const crypto = require('crypto');

const USER_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * Per-buyer SpaceBot dashboard token.
 * HMAC-SHA256(seed, "spacebot-dashboard:v1:" + userId) hex, first 48 chars.
 * The SpaceBot process checks the same value against the request Host
 * (`src/api/tenant_auth.rs`). A token for buyer A does not authenticate on
 * buyer B's host. Seed is SPACEBOT_DASHBOARD_TOKEN_SEED or AIMARKETS_SERVICE_SECRET.
 */
function dashboardTokenSeed() {
  return String(
    process.env.SPACEBOT_DASHBOARD_TOKEN_SEED || process.env.AIMARKETS_SERVICE_SECRET || '',
  ).trim();
}

function dashboardTokenForUser(userId) {
  const id = String(userId || '').trim().toLowerCase();
  const seed = dashboardTokenSeed();
  if (!USER_ID_RE.test(id) || !seed) return '';
  return crypto.createHmac('sha256', seed).update(`spacebot-dashboard:v1:${id}`).digest('hex').slice(0, 48);
}

module.exports = { dashboardTokenForUser, dashboardTokenSeed, USER_ID_RE };
