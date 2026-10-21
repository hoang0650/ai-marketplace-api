require('dotenv').config();
const { DEFAULT_VND_PER_USD } = require('./fx');

const DEV_JWT_FALLBACK = 'phai-market-dev-secret';

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const jwtSecret = (process.env.JWT_SECRET || DEV_JWT_FALLBACK).trim();
const refreshTokenSecret = (process.env.REFRESH_TOKEN_SECRET || `${jwtSecret}-refresh`).trim();

// Fail fast: never boot production with a default/weak secret.
if (isProduction) {
  if (!process.env.JWT_SECRET || jwtSecret === DEV_JWT_FALLBACK || jwtSecret.length < 24) {
    console.error(
      '[config] FATAL: JWT_SECRET must be set to a strong value (>= 24 chars) in production.'
    );
    process.exit(1);
  }
  if (
    !process.env.REFRESH_TOKEN_SECRET ||
    refreshTokenSecret.length < 24 ||
    refreshTokenSecret === jwtSecret ||
    refreshTokenSecret === `${DEV_JWT_FALLBACK}-refresh`
  ) {
    console.error(
      '[config] FATAL: REFRESH_TOKEN_SECRET must be set to a strong value (>= 24 chars), different from JWT_SECRET.'
    );
    process.exit(1);
  }
  if (!process.env.MDB_CONNECT) {
    console.error('[config] FATAL: MDB_CONNECT must be set in production.');
    process.exit(1);
  }
}

const config = {
  port: Number(process.env.PORT || 4100),
  mongoUri: (process.env.MDB_CONNECT || 'mongodb://127.0.0.1:27017/ai_marketplace').trim(),
  jwtSecret,
  refreshTokenSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  refreshExpiresIn: process.env.REFRESH_EXPIRES_IN || '30d',
  cookieSameSite: (process.env.COOKIE_SAMESITE || 'lax').trim(),
  corsOrigins: String(process.env.CORS_ORIGINS || 'http://localhost:4200')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  nodeEnv,
  isProduction,
  // Rate limiting (per IP)
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_LIMIT_MAX || 300),
    authWindowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60_000),
    authMax: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
    refreshWindowMs: Number(process.env.REFRESH_RATE_LIMIT_WINDOW_MS || 15 * 60_000),
    refreshMax: Number(process.env.REFRESH_RATE_LIMIT_MAX || 60),
  },
  // Behind a reverse proxy (Render/Vercel/NGINX) set TRUST_PROXY=1
  trustProxy: process.env.TRUST_PROXY === '1' || isProduction,
  /** AI router (denglish-api) — not the same process as this platform API */
  denglishApiUrl: (process.env.DENGLISH_API_URL || 'http://127.0.0.1:8000').trim(),
  denglishServiceKey: (process.env.DENGLISH_SERVICE_KEY || '').trim(),
  denglishTimeoutMs: Number(process.env.DENGLISH_TIMEOUT_MS || 180_000),
  /** Dev fallback when denglish-api is down (default on outside production) */
  denglishSandbox:
    process.env.DENGLISH_SANDBOX === '1' ||
    process.env.DENGLISH_SANDBOX === 'true' ||
    (!isProduction && process.env.DENGLISH_SANDBOX !== '0'),
  proxvnEnabled:
    process.env.PROXVN_ENABLED === '1' ||
    process.env.PROXVN_ENABLED === 'true' ||
    !!String(process.env.PROXVN_BASE_DOMAIN || '').trim(),
  proxvnBaseDomain: (process.env.PROXVN_BASE_DOMAIN || '').trim(),
  proxvnServer: (process.env.PROXVN_SERVER || '').trim(),
  /** Resend transactional mail — From must be a verified domain */
  resendApiKey: (process.env.RESEND_API_KEY || '').trim(),
  emailFrom: (process.env.EMAIL_FROM || process.env.RESEND_FROM || 'AI Markets <noreply@aimarkets.vn>').trim(),
  emailReplyTo: (process.env.EMAIL_REPLY_TO || 'support@aimarkets.vn').trim(),
  frontendUrl: (process.env.FRONTEND_URL || process.env.APP_URL || 'https://aimarkets.vn').trim(),
  /** Public base URL of this API — used for provider webhook callbacks. */
  apiPublicUrl: (process.env.API_PUBLIC_URL || process.env.PUBLIC_API_URL || '').trim(),
  skipEmail:
    process.env.SKIP_EMAIL === '1' ||
    process.env.SKIP_EMAIL === 'true' ||
    nodeEnv === 'test' ||
    !!process.env.NODE_TEST_CONTEXT,
  /** AES wrapping for licensed film/story downloads — not the license key itself. */
  contentDrmSecret: (process.env.CONTENT_DRM_SECRET || '').trim(),
  /** Same PayPal REST Orders v2 credentials as phhotel-api */
  paypalClientId: (process.env.PAYPAL_CLIENT_ID || '').trim(),
  paypalClientSecret: (process.env.PAYPAL_CLIENT_SECRET || '').trim(),
  paypalSandbox: process.env.PAYPAL_SANDBOX !== 'false',
  paypalVndPerUsd: Number(process.env.PAYPAL_VND_PER_USD || DEFAULT_VND_PER_USD),
  /**
   * GPay (G-Pay Vietnam) — runs alongside PayPal for wallet top-up.
   * Virtual Account = VND collection account per user (webhook credits the wallet).
   *
   * Feature flag (temporarily OFF): GPay top-up is disabled unless GPAY_ENABLED is
   * explicitly `true`/`1`. Default is OFF because Dokploy redeploys wipe runtime env
   * vars, so an unset variable must never re-open the gateway. When OFF, creating new
   * GPay payments is rejected (503 GPAY_DISABLED) but the webhook, return URL and
   * order status endpoints keep working so in-flight transactions still settle.
   */
  gpayVaEnabled: ['1', 'true', 'yes', 'on'].includes(String(process.env.GPAY_ENABLED || '').trim().toLowerCase()),
  /** Manual VietQR bank top-up (see config/bank-transfer.js). */
  bankTopupEnabled: !!(String(process.env.BANK_ACCOUNT || '').trim() && String(process.env.BANK_ACCOUNT_NAME || '').trim()),
  gpaySandbox: process.env.GPAY_SANDBOX !== 'false',
  gpayMerchantCode: (process.env.GPAY_MERCHANT_CODE || '').trim(),
  gpayPassword: (process.env.GPAY_PASSWORD || '').trim(),
  /** PKCS#8/PKCS#1 PEM (or base64) we use to sign requests sent to GPay. */
  gpayPrivateKey: (process.env.GPAY_PRIVATE_KEY || '').trim(),
  /** GPay's public key override; defaults to the embedded sandbox/product key. */
  gpayPublicKey: (process.env.GPAY_PUBLIC_KEY || '').trim(),
  /**
   * The GPay merchant contract belongs to PHHotel: GPay calls phhotel-api, which
   * relays AI Markets accounts to /v1/gpay/webhook with this shared secret.
   */
  gpayWebhookUrl: (process.env.GPAY_WEBHOOK_URL || 'https://api.phhotel.vn/gpay/webhook').trim(),
  /** Payment gateway v4 ("1 cổng"); defaults to the QR/VA merchant credentials. */
  gpayPortalMerchantCode: (process.env.GPAY_PORTAL_MERCHANT_CODE || process.env.GPAY_MERCHANT_CODE || '').trim(),
  gpayPortalPassword: (process.env.GPAY_PORTAL_PASSWORD || process.env.GPAY_PASSWORD || '').trim(),
  gpayPortalCredsShared: !process.env.GPAY_PORTAL_MERCHANT_CODE,
  /** Host overrides (e.g. https://mpa-va-sandbox.g-pay.vn/api/v3); default follows GPAY_SANDBOX. */
  gpayVaBaseUrl: (process.env.GPAY_VA_BASE_URL || '').trim().replace(/\/+$/, ''),
  gpayPortalBaseUrl: (process.env.GPAY_PORTAL_BASE_URL || '').trim().replace(/\/+$/, ''),
  /** Empty = customer picks ATM / card / VA on GPay's page. */
  gpayPortalPaymentMethod: (process.env.GPAY_PORTAL_PAYMENT_METHOD || '').trim(),
  gpayQrSourceOfFund: (process.env.GPAY_QR_SOURCE_OF_FUND || 'VIETQR').trim(),
  gpayQrTerminalId: (process.env.GPAY_QR_TERMINAL_ID || '').trim(),
  gpayQrStoreCode: (process.env.GPAY_QR_STORE_CODE || '').trim(),
  gpayRelaySecret: (process.env.GPAY_RELAY_SECRET || '').trim(),
  gpayBankCode: (process.env.GPAY_BANK_CODE || 'VCCB').trim(),
  gpayVaBankCode: (process.env.GPAY_VA_BANK_CODE || process.env.GPAY_BANK_CODE || 'VCCB').trim(),
  gpayAccountType: (process.env.GPAY_ACCOUNT_TYPE || 'M').trim(),
  /** VND per USD used to credit the (USD) wallet from a VND VA deposit. */
  gpayVndPerUsd: Number(process.env.GPAY_VND_PER_USD || process.env.PAYPAL_VND_PER_USD || DEFAULT_VND_PER_USD),
  gpayMinTopupVnd: Number(process.env.GPAY_MIN_TOPUP_VND || 10000),
  appleIapSharedSecret: (process.env.APPLE_IAP_SHARED_SECRET || '').trim(),
  appleIapIssuerId: (process.env.APPLE_IAP_ISSUER_ID || '').trim(),
  appleIapKeyId: (process.env.APPLE_IAP_KEY_ID || '').trim(),
  appleIapPrivateKey: (process.env.APPLE_IAP_PRIVATE_KEY || '').trim(),
  appleIapBundleId: (process.env.APPLE_IAP_BUNDLE_ID || 'app.phgroup.ai-market-vn').trim(),
  googlePlayPackageName: (process.env.GOOGLE_PLAY_PACKAGE_NAME || 'app.phgroup.ai_market_vn').trim(),
  googlePlayServiceAccountJson: (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim(),
  /** Production never skips store verify. Dev skips unless IAP_SKIP_VERIFY=0. Tests skip. */
  iapSkipVerify:
    nodeEnv === 'test' || !!process.env.NODE_TEST_CONTEXT
      ? true
      : isProduction
        ? false
        : process.env.IAP_SKIP_VERIFY !== '0',
};

if (isProduction && config.denglishApiUrl && !config.denglishServiceKey) {
  console.error('[config] FATAL: DENGLISH_SERVICE_KEY must be set in production (ai.aimarkets.vn service auth).');
  process.exit(1);
}

if (isProduction && !config.resendApiKey) {
  console.warn('[config] RESEND_API_KEY is empty — checkout confirmation emails will not be sent.');
}

if (isProduction && (!config.contentDrmSecret || config.contentDrmSecret.length < 24)) {
  console.warn('[config] CONTENT_DRM_SECRET should be a strong random value (>= 24 chars) for licensed film/story downloads.');
}

if (isProduction) {
  if (process.env.IAP_SKIP_VERIFY === '1' || process.env.IAP_SKIP_VERIFY === 'true') {
    console.warn('[config] IAP_SKIP_VERIFY is ignored in production — store receipts are always verified.');
  }
  const appleReady = !!(config.appleIapIssuerId && config.appleIapKeyId && config.appleIapPrivateKey)
    || !!config.appleIapSharedSecret;
  const googleReady = !!config.googlePlayServiceAccountJson;
  if (!appleReady) {
    console.warn('[config] Apple IAP keys missing — POST /v1/iap/verify (ios) will fail until APPLE_IAP_ISSUER_ID/KEY_ID/PRIVATE_KEY or APPLE_IAP_SHARED_SECRET is set.');
  }
  if (!googleReady) {
    console.warn('[config] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON missing — POST /v1/iap/verify (android) will fail.');
  }
}

module.exports = config;
