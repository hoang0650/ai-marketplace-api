require('dotenv').config();

const DEV_JWT_FALLBACK = 'phai-market-dev-secret';

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const jwtSecret = (process.env.JWT_SECRET || DEV_JWT_FALLBACK).trim();

// Fail fast: never boot production with a default/weak secret.
if (isProduction) {
  if (!process.env.JWT_SECRET || jwtSecret === DEV_JWT_FALLBACK || jwtSecret.length < 24) {
    console.error(
      '[config] FATAL: JWT_SECRET must be set to a strong value (>= 24 chars) in production.'
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
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
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
};

module.exports = config;
