const config = require('../config/env');

/**
 * ProxVN (proxvn_tunnel_full) is the public HTTPS edge for GPU streams and
 * seller APIs. The browser never sees RunPod / OpenRouter / Featherless hosts.
 *
 * Typical setup: `proxvn --proto http 4100` on the marketplace API, with
 * PROXVN_BASE_DOMAIN=bacsycay.click so Host `gs-<id>.bacsycay.click` maps here.
 */

function baseDomain() {
  return String(config.proxvnBaseDomain || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function enabled() {
  return !!config.proxvnEnabled && !!baseDomain();
}

function sanitizeId(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 48);
}

function publicHttps(prefix, id) {
  if (!enabled()) return '';
  const slug = sanitizeId(id);
  if (!slug) return '';
  return `https://${prefix}-${slug}.${baseDomain()}`;
}

function parseHost(hostHeader) {
  const domain = baseDomain();
  if (!domain || !hostHeader) return null;
  const host = String(hostHeader).split(':')[0].toLowerCase();
  if (host === domain || host === `www.${domain}`) return null;
  if (!host.endsWith(`.${domain}`)) return null;
  const sub = host.slice(0, -(domain.length + 1));
  const m = sub.match(/^(gs|api|inf)-([a-z0-9-]+)$/);
  if (!m) return null;
  return { kind: m[1], id: m[2], host };
}

function originAllowed(origin) {
  if (!origin || !enabled()) return false;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    const domain = baseDomain();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/**
 * Rewrite incoming ProxVN Host to internal Express routes.
 */
function proxvnIngress(req, _res, next) {
  const parsed = parseHost(req.headers.host);
  if (!parsed) return next();
  req.proxvn = parsed;
  const qIndex = (req.url || '').indexOf('?');
  const qs = qIndex >= 0 ? req.url.slice(qIndex) : '';
  const path = qIndex >= 0 ? req.url.slice(0, qIndex) : req.url || '/';
  if (parsed.kind === 'gs' && !path.startsWith('/v1/game-sessions/')) {
    req.url = `/v1/game-sessions/${parsed.id}/player${qs}`;
  } else if (parsed.kind === 'inf' && !path.startsWith('/v1/')) {
    req.url = `/v1/edge/infer/${parsed.id}${qs}`;
  } else if (parsed.kind === 'api' && !path.startsWith('/v1/')) {
    req.url = `/v1/edge/infer/${parsed.id}${qs}`;
  }
  next();
}

module.exports = {
  enabled,
  baseDomain,
  publicHttps,
  parseHost,
  originAllowed,
  proxvnIngress,
};
