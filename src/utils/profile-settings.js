const INTRO_LINES = ['', 'buyer', 'seller', 'builder', 'learner'];
const NOTIFY_LANGS = ['vi', 'en', 'zh'];
const MAX_SOCIALS = 5;

function badRequest(message, code) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

/** '' clears; otherwise only absolute http(s) URLs (no data:/javascript:, which also broke truncated avatars). */
function sanitizeUrl(value, { max = 300, field = 'url' } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.length > max) throw badRequest(`${field} is too long (max ${max})`, 'URL_TOO_LONG');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw badRequest(`${field} must be a valid http(s) URL`, 'URL_INVALID');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw badRequest(`${field} must be a valid http(s) URL`, 'URL_INVALID');
  }
  return parsed.toString();
}

function sanitizeMediaUrl(value, field) {
  return sanitizeUrl(value, { max: 2000, field });
}

/** Merge a partial profile patch onto the current profile. Unknown keys are ignored. */
function sanitizeProfile(patch, current = {}) {
  const next = {
    introLine: current.introLine || '',
    region: current.region || '',
    website: current.website || '',
    notifyLang: current.notifyLang || 'vi',
    socials: Array.isArray(current.socials) ? current.socials.map((s) => ({ label: s.label, url: s.url })) : [],
  };
  if (!patch || typeof patch !== 'object') return next;
  if (patch.introLine !== undefined) {
    const v = String(patch.introLine || '');
    if (!INTRO_LINES.includes(v)) throw badRequest('Invalid introLine', 'PROFILE_INVALID');
    next.introLine = v;
  }
  if (patch.region !== undefined) next.region = String(patch.region || '').trim().slice(0, 120);
  if (patch.website !== undefined) next.website = sanitizeUrl(patch.website, { field: 'website' });
  if (patch.notifyLang !== undefined) {
    const v = String(patch.notifyLang || '');
    if (!NOTIFY_LANGS.includes(v)) throw badRequest('Invalid notifyLang', 'PROFILE_INVALID');
    next.notifyLang = v;
  }
  if (patch.socials !== undefined) {
    if (!Array.isArray(patch.socials)) throw badRequest('socials must be an array', 'PROFILE_INVALID');
    const rows = patch.socials
      .map((s) => ({ label: String(s?.label || '').trim().slice(0, 40), url: String(s?.url || '').trim() }))
      .filter((s) => s.url);
    if (rows.length > MAX_SOCIALS) throw badRequest(`At most ${MAX_SOCIALS} social links`, 'PROFILE_INVALID');
    next.socials = rows.map((s) => ({ label: s.label || 'Link', url: sanitizeUrl(s.url, { field: 'social url' }) }));
  }
  return next;
}

function sanitizePreferences(patch, current = {}) {
  const next = {
    personalizeContent: !!current.personalizeContent,
    personalizeAds: !!current.personalizeAds,
  };
  if (!patch || typeof patch !== 'object') return next;
  if (patch.personalizeContent !== undefined) next.personalizeContent = !!patch.personalizeContent;
  if (patch.personalizeAds !== undefined) next.personalizeAds = !!patch.personalizeAds;
  return next;
}

/** Account events derived from timestamps we already store (no separate audit log). */
function accountActivity(user, session) {
  const events = [];
  const push = (type, at, extra = {}) => {
    if (!at) return;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return;
    events.push({ type, at: d.toISOString(), ...extra });
  };
  push('account_created', user?.createdAt);
  push('profile_updated', user?.profileUpdatedAt);
  push('password_changed', user?.passwordChangedAt);
  push('kyc_submitted', user?.kyc?.submittedAt);
  if (user?.kyc?.reviewedAt && ['verified', 'rejected'].includes(user.kyc.status)) {
    push(user.kyc.status === 'verified' ? 'kyc_verified' : 'kyc_rejected', user.kyc.reviewedAt);
  }
  if (session?.lastLogin) push('last_login', session.lastLogin, { ip: session.lastLoginIp || null });
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

module.exports = {
  INTRO_LINES,
  NOTIFY_LANGS,
  MAX_SOCIALS,
  sanitizeUrl,
  sanitizeMediaUrl,
  sanitizeProfile,
  sanitizePreferences,
  accountActivity,
};
