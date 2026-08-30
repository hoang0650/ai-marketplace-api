function getGoogleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
}

function getGoogleClientIds() {
  const ids = [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_IOS_CLIENT_ID, process.env.GOOGLE_ANDROID_CLIENT_ID]
    .filter(Boolean)
    .map((v) => String(v).trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function getGoogleClientSecret() {
  return String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
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

async function verifyGoogleAuthCode(code, redirectUri = 'postmessage') {
  const clientId = getGoogleClientId();
  const clientSecret = getGoogleClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error('Chưa cấu hình GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  }

  const authCode = String(code || '').trim();
  if (!authCode) throw new Error('Thiếu Google authorization code');

  const body = new URLSearchParams({
    code: authCode,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: String(redirectUri || 'postmessage'),
    grant_type: 'authorization_code',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id_token) {
    const detail = data.error_description || data.error || 'token exchange failed';
    const err = new Error(`Google token exchange thất bại: ${detail}`);
    err.statusCode = 401;
    throw err;
  }
  return verifyGoogleIdToken(data.id_token);
}

module.exports = {
  getGoogleClientId,
  getGoogleClientIds,
  verifyGoogleIdToken,
  verifyGoogleAuthCode,
};
