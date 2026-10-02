/**
 * Block user-supplied URLs / domains in buyer–seller chat (phishing).
 * Marketplace image URLs are allowed only on the dedicated imageUrl field.
 */
const { mediaHosts } = require('../config/minio');

const PROTOCOL_RE = /(?:https?:\/\/|ftp:\/\/|ftps:\/\/|\/\/)/i;
const WWW_RE = /\bwww\./i;
const MD_LINK_RE = /\[[^\]]*]\(\s*[^)]+\)/;
const SHORT_RE = /\b(?:t\.me|telegram\.me|wa\.me|bit\.ly|tinyurl\.com|goo\.gl|ow\.ly)\b/i;
const DOMAIN_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|vn|xyz|me|co|info|biz|app|dev|ai|shop|store|link|click|top|site|online|live|tv|cc|tk|ml|ga|cf|pro|cloud)\b/i;

function containsBlockedLink(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return PROTOCOL_RE.test(s) || WWW_RE.test(s) || MD_LINK_RE.test(s) || SHORT_RE.test(s) || DOMAIN_RE.test(s);
}

function isAllowedChatImageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (!mediaHosts().has(host)) return false;
    return /\.(jpe?g|png|webp)(\?|$)/i.test(parsed.pathname) || /\/(playground|uploads|chat|voice)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

module.exports = { containsBlockedLink, isAllowedChatImageUrl };
