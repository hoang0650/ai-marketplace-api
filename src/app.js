const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const morgan = require('morgan');
const config = require('./config/env');
const { isDbReady } = require('./config/db');
const { isReady: isRedisReady } = require('./config/redis');
const { notFound, errorHandler } = require('./middleware/error');
const { proxvnIngress, originAllowed } = require('./utils/proxvn');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const creatorRoutes = require('./routes/creators');
const categoryRoutes = require('./routes/categories');
const reviewRoutes = require('./routes/reviews');
const wishlistRoutes = require('./routes/wishlist');
const orderRoutes = require('./routes/orders');
const walletRoutes = require('./routes/wallet');
const usageRoutes = require('./routes/usage');
const dashboardRoutes = require('./routes/dashboard');
const notificationRoutes = require('./routes/notifications');
const affiliateRoutes = require('./routes/affiliate');
const billingRoutes = require('./routes/billing');
const adminRoutes = require('./routes/admin');
const openclawRoutes = require('./routes/openclaw');
const deploymentRoutes = require('./routes/deployments');
const runpodRoutes = require('./routes/runpod');
const playgroundRoutes = require('./routes/playground');
const agentsRoutes = require('./routes/agents');
const { router: serverRoutes } = require('./routes/servers');
const terminalRoutes = require('./routes/terminal');
const gameSessionRoutes = require('./routes/game-sessions');
const providerCatalogRoutes = require('./routes/providers');
const edgeRoutes = require('./routes/edge');
const v1GatewayRoutes = require('./routes/v1-gateway');
const apiKeyRoutes = require('./routes/api-keys');
const agentTemplateRoutes = require('./routes/agent-templates');
const trainingJobRoutes = require('./routes/training-jobs');

function createApp() {
  const app = express();

  // Behind Render/NGINX/Cloudflare so req.ip and rate limiting work correctly.
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(proxvnIngress);

  // Security headers — API only, no cross-origin embedding needed.
  app.use(
    helmet({
      contentSecurityPolicy: false, // JSON API, no HTML served
      frameguard: false, // game player iframe is served by this API for the marketplace origin
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || config.corsOrigins.includes(origin) || config.corsOrigins.includes('*')) {
          return cb(null, true);
        }
        if (originAllowed(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    })
  );

  app.use(compression());
  app.use(
    morgan(config.isProduction ? 'combined' : 'dev', {
      skip: (req) => req.path === '/health' || req.path === '/health/ready',
    })
  );
  app.use(express.json({ limit: '1mb' }));
  // Strip Mongo operators ($, .) from user payloads to prevent operator injection.
  app.use(mongoSanitize());

  // Liveness — process is up.
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'ai-marketplace-api', uptime: process.uptime() });
  });
  // Readiness — MongoDB required; Redis is optional (informational only).
  app.get('/health/ready', (_req, res) => {
    const ready = isDbReady();
    res.status(ready ? 200 : 503).json({
      ok: ready,
      db: ready ? 'connected' : 'disconnected',
      cache: isRedisReady() ? 'connected' : 'off',
    });
  });

  // Global API rate limit.
  const apiLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests, please slow down.' },
  });
  // Stricter limit for credential endpoints (brute-force protection).
  const authLimiter = rateLimit({
    windowMs: config.rateLimit.authWindowMs,
    max: config.rateLimit.authMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many auth attempts, please try again later.' },
  });

  app.use('/v1', apiLimiter);
  app.use('/v1/auth/login', authLimiter);
  app.use('/v1/auth/register', authLimiter);

  // Static RunPod Public Endpoints catalog (docs) — no DB required.
  app.use('/v1/runpod', runpodRoutes);

  app.use('/v1', (req, res, next) => {
    if (isDbReady()) return next();
    return res.status(503).json({
      message: 'Database is not connected yet. Please try again in a moment.',
    });
  });

  app.use('/v1/auth', authRoutes);
  app.use('/v1/products', productRoutes);
  app.use('/v1/creators', creatorRoutes);
  app.use('/v1/categories', categoryRoutes);
  app.use('/v1/reviews', reviewRoutes);
  app.use('/v1/wishlist', wishlistRoutes);
  app.use('/v1/orders', orderRoutes);
  app.use('/v1/wallet', walletRoutes);
  app.use('/v1/usage', usageRoutes);
  app.use('/v1/dashboard', dashboardRoutes);
  app.use('/v1/notifications', notificationRoutes);
  app.use('/v1/affiliate', affiliateRoutes);
  app.use('/v1/billing', billingRoutes);
  app.use('/v1/admin', adminRoutes);
  app.use('/v1/openclaw', openclawRoutes);
  app.use('/v1/deployments', deploymentRoutes);
  app.use('/v1/playground', playgroundRoutes);
  app.use('/v1/agents', agentsRoutes);
  app.use('/v1/servers', serverRoutes);
  app.use('/v1/terminal', terminalRoutes);
  app.use('/v1/game-sessions', gameSessionRoutes);
  app.use('/v1/providers', providerCatalogRoutes);
  app.use('/v1/edge', edgeRoutes);
  app.use('/v1', v1GatewayRoutes);
  app.use('/v1/api-keys', apiKeyRoutes);
  app.use('/v1/agent-templates', agentTemplateRoutes);
  app.use('/v1/training-jobs', trainingJobRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
