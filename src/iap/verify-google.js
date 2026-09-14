const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { ANDROID_PACKAGE } = require('./constants');
const { parseJsonEnv } = require('./parse-json-env');

function googleServiceAccount() {
  return parseJsonEnv(config.googlePlayServiceAccountJson);
}

function googleConfigured() {
  const sa = googleServiceAccount();
  return Boolean(sa?.client_email && sa?.private_key);
}

async function googleAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    sa.private_key,
    { algorithm: 'RS256' },
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = await res.json();
  if (!json.access_token) {
    return { ok: false, code: 'IAP_GOOGLE_AUTH', message: 'Google Play service account token failed' };
  }
  return { ok: true, token: json.access_token };
}

async function verifyGoogleIap({ productId, purchaseToken, packageName }) {
  if (!purchaseToken) {
    return { ok: false, code: 'IAP_NO_TX', message: 'Google Play purchaseToken required' };
  }
  const sa = googleServiceAccount();
  if (!sa) {
    return {
      ok: false,
      code: 'IAP_NOT_CONFIGURED',
      message: 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not configured',
    };
  }
  const auth = await googleAccessToken(sa);
  if (!auth.ok) return auth;

  const pkg = String(packageName || config.googlePlayPackageName || ANDROID_PACKAGE).trim();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      code: 'IAP_GOOGLE_API',
      message: json.error?.message || `Google Play verify ${res.status}`,
    };
  }
  if (Number(json.purchaseState) !== 0) {
    return { ok: false, code: 'IAP_GOOGLE_STATE', message: 'Google Play purchase is not completed' };
  }
  return {
    ok: true,
    transactionId: String(json.orderId || purchaseToken),
    environment: json.purchaseType === 0 ? 'sandbox' : 'production',
  };
}

module.exports = { googleConfigured, verifyGoogleIap };
