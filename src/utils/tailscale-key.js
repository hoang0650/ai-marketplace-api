const crypto = require('crypto');
const URL = 'https://api.runpod.io/v2/account/secrets';

// Registration auth keys are independent of an already connected device's node key.
async function syncTailscaleKey({ env = process.env, request = fetch, cache, log = console } = {}) {
  const key = (env.TAILSCALE_AUTHKEY || '').trim();
  const name = (env.RUNPOD_TS_SECRET_NAME || 'aimx_ts_authkey').trim();
  const report = { secret: name, envSet: !!key };
  if (key && !/^tskey-auth-[A-Za-z0-9_-]{10,}$/.test(key)) {
    log.error('[tailscale] Invalid TAILSCALE_AUTHKEY format; secret unchanged');
    return { ...report, sync: 'invalid-format' };
  }
  if (!env.RUNPOD_API_KEY) return { ...report, sync: 'no-runpod-key' };
  const headers = { Authorization: `Bearer ${env.RUNPOD_API_KEY}`, 'Content-Type': 'application/json' };
  async function call(path = '', method = 'GET', body) {
    const r = await request(URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    // Do not include vendor bodies/errors: they may echo the submitted key.
    if (!r.ok) throw new Error(`RunPod HTTP ${r.status}`);
    return r.status === 204 ? {} : r.json();
  }
  try {
    const data = await call();
    const meta = (Array.isArray(data) ? data : data.secrets || data.items || []).find(s => s.name === name);
    if (!meta?.id) return { ...report, sync: 'secret-missing' };
    const fp = crypto.createHash('sha256').update(key).digest('hex');
    const cacheKey = 'tailscale:authkey:' + name;
    const previous = cache ? await cache.getCache(cacheKey) : null;
    if (key && previous !== fp) {
      await call('/' + encodeURIComponent(meta.id), 'PATCH', { value: key });
      if (cache) await cache.setCache(cacheKey, fp, 200 * 86400);
      report.sync = 'updated';
    } else report.sync = key ? 'unchanged' : 'env-unset';
    const expiry = Date.parse(env.TAILSCALE_AUTHKEY_EXPIRES_AT || '');
    if (Number.isFinite(expiry)) {
      report.expiresAt = new Date(expiry).toISOString();
      report.daysRemaining = Math.floor((expiry - Date.now()) / 86400000);
      if (report.daysRemaining <= Number(env.TAILSCALE_AUTHKEY_WARN_DAYS || 10)) log.warn('[tailscale] Registration auth key expires soon; update TAILSCALE_AUTHKEY and redeploy API');
    }
    log.info(`[tailscale] secret=${name} sync=${report.sync}; new workers read the secret at boot`);
    return report;
  } catch (_) {
    log.error('[tailscale] RunPod secret sync failed; existing secret unchanged or update unconfirmed');
    return { ...report, sync: 'error' };
  }
}
module.exports = { syncTailscaleKey };
