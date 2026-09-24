const config = require('./env');

function getGoogleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
}

function getGoogleClientIds() {
  const ids = [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
  ]
    .filter(Boolean)
    .map((v) => String(v).trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function getGoogleClientSecret() {
  return String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
}

function getGoogleIosClientId() {
  return String(process.env.GOOGLE_IOS_CLIENT_ID || '').trim();
}

function getGoogleAndroidClientId() {
  return String(process.env.GOOGLE_ANDROID_CLIENT_ID || '').trim();
}

function isNativeGoogleRedirectUri(redirectUri) {
  return /^com\.googleusercontent\.apps\.[^:]+:/.test(String(redirectUri || ''));
}

/**
 * Pick the OAuth client used to exchange an authorization code.
 *
 * - Reverse-client-ID redirect (`com.googleusercontent.apps.{id}:/…`): the iOS
 *   client, a public client (no secret, PKCE verifier instead).
 * - http(s) redirect or `postmessage`: always the Web client + secret.
 *
 * Android clients never exchange codes: Google no longer allows custom URI
 * schemes on Android and Android clients have no redirect URIs. The Android
 * client only appears as the `azp` of ID tokens minted by the native SDK
 * (see verifyGoogleIdToken).
 */
function resolveGoogleCodeExchangeCredentials(redirectUri, explicitClientId) {
  const uri = String(redirectUri || 'postmessage').trim();
  const webClientId = getGoogleClientId();
  const iosClientId = getGoogleIosClientId();
  const androidClientId = getGoogleAndroidClientId();
  const requested = String(explicitClientId || '').trim();

  let clientId;
  let clientSecret = null;

  if (isNativeGoogleRedirectUri(uri)) {
    const schemePrefix = uri.match(/^com\.googleusercontent\.apps\.([^:]+):/)?.[1];
    const fromScheme = schemePrefix ? `${schemePrefix}.apps.googleusercontent.com` : '';
    if (!iosClientId) throw new Error('Chưa cấu hình GOOGLE_IOS_CLIENT_ID');
    if (fromScheme !== iosClientId || (requested && requested !== iosClientId)) {
      throw new Error('Google client_id không được phép');
    }
    clientId = iosClientId;
  } else {
    if (requested && androidClientId && requested === androidClientId) {
      throw new Error('Android client không đổi được mã Google; dùng ID token từ SDK Android');
    }
    if (requested && requested !== webClientId) {
      throw new Error('Google client_id không được phép');
    }
    clientId = webClientId;
    clientSecret = getGoogleClientSecret();
    if (!clientId) throw new Error('Chưa cấu hình GOOGLE_CLIENT_ID');
    if (!clientSecret) throw new Error('Chưa cấu hình GOOGLE_CLIENT_SECRET cho Web client');
  }

  return { clientId, clientSecret, redirectUri: uri };
}

function publicApiBase(req) {
  if (config.isProduction) {
    const env = String(process.env.AIMARKETS_API_HOST || process.env.PUBLIC_API_URL || '')
      .trim()
      .replace(/\/$/, '');
    if (env) return env;
  }
  const proto = req.protocol || (config.isProduction ? 'https' : 'http');
  const host = req.get('host') || `127.0.0.1:${config.port}`;
  return `${proto}://${host}`;
}

function googleCallbackUrl(req) {
  return `${publicApiBase(req)}/v1/auth/google/callback`;
}

function allowedFrontendOrigins() {
  const extra = String(config.frontendUrl || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return [...new Set([...config.corsOrigins, ...extra])];
}

function isAllowedFrontendOrigin(origin) {
  const o = String(origin || '').replace(/\/$/, '');
  if (!o) return false;
  return allowedFrontendOrigins().some((allowed) => allowed.replace(/\/$/, '') === o);
}

function normalizeReturnTo(raw, fallbackOrigin) {
  const fallbackPath = '/';
  const origin = String(fallbackOrigin || config.frontendUrl || 'https://aimarkets.vn').replace(/\/$/, '');
  if (!raw) return { origin, path: fallbackPath };
  try {
    if (raw.startsWith('/')) {
      return { origin, path: raw.split('?')[0] || fallbackPath };
    }
    const u = new URL(raw);
    const o = u.origin;
    if (!isAllowedFrontendOrigin(o)) {
      return { origin, path: fallbackPath };
    }
    return { origin: o, path: `${u.pathname}${u.search}` || fallbackPath };
  } catch {
    return { origin, path: fallbackPath };
  }
}

function normalizeGoogleProfile(payload) {
  if (!payload?.sub) throw new Error('Google token không hợp lệ');
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) throw new Error('Google không cung cấp email');
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (!verified) throw new Error('Email Google chưa được xác minh');
  return {
    googleId: String(payload.sub),
    email,
    fullName: String(payload.name || '').trim(),
    avatar: String(payload.picture || '').trim(),
  };
}

async function verifyGoogleIdToken(idToken) {
  const allowed = getGoogleClientIds();
  if (!allowed.length) throw new Error('Chưa cấu hình GOOGLE_CLIENT_ID');

  const token = String(idToken || '').trim();
  if (!token) throw new Error('Thiếu Google ID token');

  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error('Google ID token không hợp lệ');
  const data = await res.json();

  const audiences = [data.aud, data.azp].filter(Boolean).map(String);
  if (!audiences.some((aud) => allowed.includes(aud))) {
    throw new Error('Google token không khớp ứng dụng');
  }
  return normalizeGoogleProfile(data);
}

async function verifyGoogleAuthCode(code, redirectUri = 'postmessage', explicitClientId, codeVerifier) {
  const authCode = String(code || '').trim();
  if (!authCode) throw new Error('Thiếu Google authorization code');

  const { clientId, clientSecret, redirectUri: resolvedRedirectUri } = resolveGoogleCodeExchangeCredentials(
    redirectUri,
    explicitClientId,
  );

  const body = new URLSearchParams({
    code: authCode,
    client_id: clientId,
    redirect_uri: resolvedRedirectUri,
    grant_type: 'authorization_code',
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  const verifier = String(codeVerifier || '').trim();
  if (verifier) body.set('code_verifier', verifier);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id_token) {
    const detail = data.error_description || data.error || 'token exchange failed';
    console.error('[google-auth] token exchange failed:', {
      clientId: `${clientId.slice(0, 20)}...`,
      redirectUri: resolvedRedirectUri,
      detail,
    });
    const err = new Error(`Google token exchange thất bại: ${detail}`);
    err.statusCode = 401;
    throw err;
  }
  return verifyGoogleIdToken(data.id_token);
}

module.exports = {
  getGoogleClientId,
  getGoogleClientIds,
  getGoogleIosClientId,
  getGoogleAndroidClientId,
  getGoogleClientSecret,
  resolveGoogleCodeExchangeCredentials,
  publicApiBase,
  googleCallbackUrl,
  allowedFrontendOrigins,
  isAllowedFrontendOrigin,
  normalizeReturnTo,
  verifyGoogleIdToken,
  verifyGoogleAuthCode,
};
