const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const morgan = require('morgan');
const config = require('./config/env');
const { isDbReady } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error');

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

function createApp() {
  const app = express();

  // Behind Render/NGINX/Cloudflare so req.ip and rate limiting work correctly.
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Security headers — API only, no cross-origin embedding needed.
  app.use(
    helmet({
      contentSecurityPolicy: false, // JSON API, no HTML served
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || config.corsOrigins.includes(origin) || config.corsOrigins.includes('*')) {
          return cb(null, true);
        }
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
  // Readiness — dependencies (MongoDB) available.
  app.get('/health/ready', (_req, res) => {
    const ready = isDbReady();
    res.status(ready ? 200 : 503).json({ ok: ready, db: ready ? 'connected' : 'disconnected' });
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

  app.use('/api', apiLimiter);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);

  app.use('/api', (req, res, next) => {
    if (isDbReady()) return next();
    return res.status(503).json({
      message: 'Database is not connected yet. Please try again in a moment.',
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/creators', creatorRoutes);
  app.use('/api/categories', categoryRoutes);
  app.use('/api/reviews', reviewRoutes);
  app.use('/api/wishlist', wishlistRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/wallet', walletRoutes);
  app.use('/api/usage', usageRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/affiliate', affiliateRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/openclaw', openclawRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
