const dns = require('dns').promises;
const net = require('net');

const MAX_REDIRECTS = 5;

function ipv4ToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function inCidr(ip, base, bits) {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function isBlockedIpv4(ip) {
  if (inCidr(ip, '127.0.0.0', 8)) return true;
  if (inCidr(ip, '10.0.0.0', 8)) return true;
  if (inCidr(ip, '172.16.0.0', 12)) return true;
  if (inCidr(ip, '192.168.0.0', 16)) return true;
  if (inCidr(ip, '169.254.0.0', 16)) return true;
  if (inCidr(ip, '0.0.0.0', 8)) return true;
  if (inCidr(ip, '100.64.0.0', 10)) return true;
  if (inCidr(ip, '192.0.0.0', 24)) return true;
  if (inCidr(ip, '192.0.2.0', 24)) return true;
  if (inCidr(ip, '198.51.100.0', 24)) return true;
  if (inCidr(ip, '203.0.113.0', 24)) return true;
  if (inCidr(ip, '224.0.0.0', 4)) return true;
  if (inCidr(ip, '255.255.255.255', 32)) return true;
  return false;
}

function isMetadataIpv4(ip) {
  return inCidr(ip, '169.254.0.0', 16) || ip === '127.0.0.1';
}

function normalizeIp(address) {
  const raw = String(address || '').replace(/^\[|\]$/g, '');
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

function isBlockedIp(address) {
  const ip = normalizeIp(address);
  if (net.isIP(ip) === 4) return isBlockedIpv4(ip);
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('fe80:')) return true;
  }
  return false;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
  if (host === 'metadata.google.internal' || host === 'metadata' || host.endsWith('.internal')) return true;
  if (host.endsWith('.local')) return true;
  if (net.isIP(host) === 4) return isBlockedIpv4(host);
  if (net.isIP(host) === 6) return isBlockedIp(host);
  return false;
}

function parseHttpUrl(raw, { httpsOnly = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch {
    const err = new Error('Invalid URL');
    err.status = 400;
    err.code = 'UNSAFE_URL';
    throw err;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    const err = new Error('Only http(s) URLs are allowed');
    err.status = 400;
    err.code = 'UNSAFE_URL';
    throw err;
  }
  if (httpsOnly && parsed.protocol !== 'https:') {
    const err = new Error('Only https URLs are allowed');
    err.status = 400;
    err.code = 'UNSAFE_URL';
    throw err;
  }
  if (parsed.username || parsed.password) {
    const err = new Error('URLs with credentials are not allowed');
    err.status = 400;
    err.code = 'UNSAFE_URL';
    throw err;
  }
  if (isBlockedHostname(parsed.hostname)) {
    const err = new Error('URL host is not allowed');
    err.status = 400;
    err.code = 'UNSAFE_URL';
    throw err;
  }
  return parsed;
}

async function assertSafeHttpUrl(raw, opts = {}) {
  const parsed = parseHttpUrl(raw, opts);
  let records;
  try {
    records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    const err = new Error('URL host could not be resolved');
    err.status = 400;
    err.code = 'UNSAFE_URL';
    throw err;
  }
  if (!records.length || records.some((r) => isBlockedIp(r.address))) {
    const err = new Error('URL resolves to a private or metadata address');
    err.status = 400;
    err.code = 'UNSAFE_URL';
    throw err;
  }
  return parsed.href;
}

async function fetchSafeHttp(url, { timeoutMs = 15000, maxBytes = 12 * 1024 * 1024, headers = {} } = {}) {
  let current = await assertSafeHttpUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetch(current, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        const err = new Error('Redirect without Location');
        err.status = 502;
        throw err;
      }
      current = await assertSafeHttpUrl(new URL(loc, current).href);
      continue;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      const err = new Error('Response too large');
      err.status = 413;
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    return { res, buffer: buf, finalUrl: current };
  }
  const err = new Error('Too many redirects');
  err.status = 502;
  throw err;
}

function assertSafeStreamHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return '';
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal' || h.endsWith('.internal')) {
    const err = new Error('Stream host is not allowed');
    err.status = 400;
    err.code = 'UNSAFE_HOST';
    throw err;
  }
  const ip = normalizeIp(h);
  if (net.isIP(ip) && isMetadataIpv4(ip)) {
    const err = new Error('Stream host is not allowed');
    err.status = 400;
    err.code = 'UNSAFE_HOST';
    throw err;
  }
  if (net.isIP(ip) === 6 && isBlockedIp(ip) && !ip.toLowerCase().startsWith('fd') && !ip.toLowerCase().startsWith('fc')) {
    const err = new Error('Stream host is not allowed');
    err.status = 400;
    err.code = 'UNSAFE_HOST';
    throw err;
  }
  return host;
}

module.exports = {
  parseHttpUrl,
  assertSafeHttpUrl,
  fetchSafeHttp,
  assertSafeStreamHost,
  isBlockedHostname,
  isBlockedIp,
};
