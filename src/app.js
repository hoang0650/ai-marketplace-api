const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const config = require('./config/env');
const { isDbReady } = require('./config/db');
const { isReady: isRedisReady } = require('./config/redis');
const { notFound, errorHandler } = require('./middleware/error');
const { proxvnIngress, originAllowed } = require('./utils/proxvn');
const { allowMarketplaceGameFrame } = require('./utils/frame-ancestors');
const { gpuWorkspaceProxy } = require('./terminal/gpu-proxy');

const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const productRoutes = require('./routes/products');
const homeRoutes = require('./routes/home');
const bannerRoutes = require('./routes/banners');
const creatorRoutes = require('./routes/creators');
const categoryRoutes = require('./routes/categories');
const reviewRoutes = require('./routes/reviews');
const wishlistRoutes = require('./routes/wishlist');
const cartRoutes = require('./routes/cart');
const orderRoutes = require('./routes/orders');
const walletRoutes = require('./routes/wallet');
const { userRouter: bankTopupUserRoutes, adminRouter: bankTopupAdminRoutes } = require('./routes/bank-topup');
const usageRoutes = require('./routes/usage');
const dashboardRoutes = require('./routes/dashboard');
const notificationRoutes = require('./routes/notifications');
const affiliateRoutes = require('./routes/affiliate');
const billingRoutes = require('./routes/billing');
const adminRoutes = require('./routes/admin');
const openclawRoutes = require('./routes/openclaw');
const sshGatewayRoutes = require('./routes/ssh-gateway');
const hermesRoutes = require('./routes/hermes');
const nanoclawRoutes = require('./routes/nanoclaw');
const spacebotRoutes = require('./routes/spacebot');
const openwebuiRoutes = require('./routes/openwebui');
const paperclipRoutes = require('./routes/paperclip');
const agentConnectRoutes = require('./routes/agent-connect');
const deploymentRoutes = require('./routes/deployments');
const runpodRoutes = require('./routes/runpod');
const mediaRoutes = require('./routes/media');
const playgroundRoutes = require('./routes/playground');
const agentsRoutes = require('./routes/agents');
const hiredAgentRoutes = require('./routes/hired-agents');
const { router: serverRoutes } = require('./routes/servers');
const terminalRoutes = require('./routes/terminal');
const gameSessionRoutes = require('./routes/game-sessions');
const sellerComputeRoutes = require('./routes/seller-compute');
const providerCatalogRoutes = require('./routes/providers');
const edgeRoutes = require('./routes/edge');
const v1GatewayRoutes = require('./routes/v1-gateway');
const { v1: modelGatewayV1, v2: modelGatewayV2 } = require('./routes/model-gateway');
const apiKeyRoutes = require('./routes/api-keys');
const agentTemplateRoutes = require('./routes/agent-templates');
const trainingJobRoutes = require('./routes/training-jobs');
const trainingDatasetRoutes = require('./routes/training-datasets');
const builderRoutes = require('./routes/builder');
const builderTemplateRoutes = require('./routes/builder-templates');
const builderGitRoutes = require('./routes/builder-git');
const workRoutes = require('./routes/work');
const hireRoutes = require('./routes/hire');
const uploadRoutes = require('./routes/uploads');
const sellerRoutes = require('./routes/sellers');
const legalRoutes = require('./routes/legal');
const adminFinanceRoutes = require('./routes/admin-finance');
const agentPurgesAdminRoutes = require('./routes/agent-purges-admin');
const tenantAdminRoutes = require('./routes/tenant-admin');
const tenantOpenaiRoutes = require('./routes/tenant-openai');
const paymentRoutes = require('./routes/payments');
const licenseRoutes = require('./routes/licenses');
const complaintRoutes = require('./routes/complaints');
const chatRoutes = require('./routes/chat');
const couponRoutes = require('./routes/coupons');
const kycRoutes = require('./routes/kyc');
const contentRoutes = require('./routes/content');
const productFileRoutes = require('./routes/product-files');
const paypalRoutes = require('./routes/paypal');
const gpayRoutes = require('./routes/gpay');
const communityAgentRoutes = require('./routes/community-agents');
const iapRoutes = require('./routes/iap');
const gpuRoutes = require('./routes/gpu');

function createApp() {
  const app = express();

  // Behind Render/NGINX/Cloudflare so req.ip and rate limiting work correctly.
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(proxvnIngress);

  // Security headers. Game player HTML is iframed from aimarkets.vn (different origin).
  app.use(
    helmet({
      contentSecurityPolicy: false,
      frameguard: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(allowMarketplaceGameFrame);
  // Workspace proxy streams raw bodies; must run before cors/compression/body parsers/rate limit.
  app.use(gpuWorkspaceProxy());

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || config.corsOrigins.includes(origin) || config.corsOrigins.includes('*')) {
          return cb(null, true);
        }
        if (originAllowed(origin)) return cb(null, true);
        // OpenClaw Control UI (BYOK page) on https://{userId}.openclaw.aimarkets.vn
        if (/^https:\/\/(?:[a-f0-9]{24}\.)?openclaw\.aimarkets\.vn$/i.test(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    })
  );

  app.use(
    compression({
      filter(req, res) {
        if (String(req.originalUrl || req.path || '').includes('/content/play')) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use(
    morgan(config.isProduction ? 'combined' : 'dev', {
      skip: (req) => req.path === '/health' || req.path === '/health/ready',
    })
  );
  app.use('/v1/studio/film', express.json({ limit: '4mb' }), require('./routes/studio-film'));
  app.use('/v1/studio', express.json({ limit: '12mb' }), require('./routes/studio'));
  // Skill runs upload input files (≤20 MB, base64) — parsed here before the global 1 MB parser.
  app.use('/v1/skills', express.json({ limit: '28mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  // Strip Mongo operators ($, .) from user payloads to prevent operator injection.
  app.use(mongoSanitize());

  // Liveness — process is up.
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'ai-marketplace-api', uptime: process.uptime() });
  });
  // Readiness — MongoDB required; Redis is on by default (informational if down).
  app.get('/health/ready', (_req, res) => {
    const ready = isDbReady();
    res.status(ready ? 200 : 503).json({
      ok: ready,
      db: ready ? 'connected' : 'disconnected',
      cache: isRedisReady() ? 'connected' : 'disconnected',
    });
  });

  // Global API rate limit.
  const apiLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests, please slow down.' },
    skip: (req) => String(req.originalUrl || req.path || '').includes('/content/play'),
  });
  // Stricter limit for credential endpoints (brute-force protection).
  const authLimiter = rateLimit({
    windowMs: config.rateLimit.authWindowMs,
    max: config.rateLimit.authMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many auth attempts, please try again later.' },
  });

  const refreshLimiter = rateLimit({
    windowMs: config.rateLimit.refreshWindowMs,
    max: config.rateLimit.refreshMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many refresh attempts, please try again later.' },
  });

  // Signed media links: video players issue many Range requests, so this sits before the API limiter.
  app.use('/v1/media', mediaRoutes);

  app.use('/v1', apiLimiter);
  app.use('/v2', apiLimiter);
  app.use('/v1/auth/login', authLimiter);
  app.use('/v1/auth/register', authLimiter);
  app.use('/v1/auth/password', authLimiter);
  app.use('/v1/auth/forgot-password', authLimiter);
  app.use('/v1/auth/reset-password', authLimiter);
  app.use('/v1/auth/google/start', authLimiter);
  app.use('/v1/auth/google/login', authLimiter);
  app.use('/v1/auth/refresh-token', refreshLimiter);
  app.use('/v1/account/deletion', authLimiter);
  app.use('/v1/account/deletion-requests', authLimiter);

  // Static public endpoints catalog (docs) — no DB required. `/v1/runpod` is the legacy path.
  app.use(['/v1/endpoints', '/v1/runpod'], runpodRoutes);

  app.use('/v1', (req, res, next) => {
    if (isDbReady()) return next();
    return res.status(503).json({
      message: 'Database is not connected yet. Please try again in a moment.',
    });
  });
  app.use('/v2', (req, res, next) => {
    if (isDbReady()) return next();
    return res.status(503).json({
      message: 'Database is not connected yet. Please try again in a moment.',
    });
  });

  app.use('/v1/auth', authRoutes);
  app.use('/v1/account', accountRoutes);
  app.use('/v1/products', productRoutes);
  app.use('/v1/home', homeRoutes);
  app.use('/v1/banners', bannerRoutes);
  app.use('/v1/creators', creatorRoutes);
  app.use('/v1/categories', categoryRoutes);
  app.use('/v1/reviews', reviewRoutes);
  app.use('/v1/wishlist', wishlistRoutes);
  app.use('/v1/cart', cartRoutes);
  app.use('/v1/orders', orderRoutes);
  app.use('/v1/wallet', walletRoutes);
  app.use('/v1/wallet/bank-transfer', bankTopupUserRoutes);
  app.use('/v1/admin/bank-deposits', bankTopupAdminRoutes);
  app.use('/v1/usage', usageRoutes);
  app.use('/v1/dashboard', dashboardRoutes);
  app.use('/v1/notifications', notificationRoutes);
  app.use('/v1/handoff', require('./routes/handoff'));
  app.use('/v1/affiliate', affiliateRoutes);
  app.use('/v1/billing', billingRoutes);
  app.use('/v1/admin/agent-purges', agentPurgesAdminRoutes);
  app.use('/v1/admin/tenant-runtime', tenantAdminRoutes);
  app.use('/v1/tenant/openai', tenantOpenaiRoutes);
  app.use('/v1/admin', adminRoutes);
  app.use('/v1/admin', adminFinanceRoutes);
  app.use('/v1/payments', paymentRoutes);
  app.use('/v1/openclaw', openclawRoutes);
  app.use('/v1/ssh-gateway', sshGatewayRoutes);
  app.use('/v1/hermes', hermesRoutes);
  app.use('/v1/nanoclaw', nanoclawRoutes);
  app.use('/v1/spacebot', spacebotRoutes);
  app.use('/v1/openwebui', openwebuiRoutes);
  app.use('/v1/paperclip', paperclipRoutes);
  app.use('/v1/agent-connect', agentConnectRoutes);
  app.use('/v1/deployments', deploymentRoutes);
  app.use('/v1/playground', playgroundRoutes);
  app.use('/v1/community-agents', communityAgentRoutes());
  app.use('/v1/agents', agentsRoutes);
  app.use('/v1/agents', hiredAgentRoutes);
  app.use('/v1/servers', serverRoutes);
  app.use('/v1/gpu', gpuRoutes);
  app.use('/v1/terminal', terminalRoutes);
  app.use('/v1/game-sessions', gameSessionRoutes);
  app.use('/v1/seller/compute', sellerComputeRoutes);
  app.use('/v1/providers', providerCatalogRoutes);
  app.use('/v1/edge', edgeRoutes);
  app.use('/v1', v1GatewayRoutes);
  app.use('/v1/models', modelGatewayV1);
  app.use('/v2', modelGatewayV2);
  app.use('/v1/api-keys', apiKeyRoutes);
  app.use('/v1/agent-templates', agentTemplateRoutes);
  app.use('/v1/training-jobs', trainingJobRoutes);
  app.use('/v1/training-datasets', trainingDatasetRoutes);
  app.use('/v1/builder/templates', builderTemplateRoutes);
  app.use('/v1/builder/git', builderGitRoutes);
  app.use('/v1/builder', builderRoutes);
  // Work board + quote-based Hire projects are discontinued (Quy chế 2.1) — 410 for new activity.
  const { workDiscontinued, hireDiscontinued } = require('./middleware/discontinued');
  app.use('/v1/work', workDiscontinued, workRoutes);
  app.use('/v1/hire', hireDiscontinued, hireRoutes);
  app.use('/v1/uploads', uploadRoutes);
  app.use('/v1/attachments', require('./routes/attachments'));
  app.use('/v1/sellers', sellerRoutes);
  app.use('/v1/legal', legalRoutes);
  app.use('/v1/licenses', licenseRoutes);
  app.use('/v1/content', contentRoutes);
  app.use('/v1/product-files', productFileRoutes);
  app.use('/v1/datasets', require('./routes/datasets-online'));
  app.use('/v1/skills', require('./routes/skills-online'));
  app.use('/v1/paypal', paypalRoutes);
  app.use('/v1/gpay', gpayRoutes);
  app.use('/v1/iap', iapRoutes);
  app.use('/v1/complaints', complaintRoutes);
  app.use('/v1/chat', chatRoutes);
  app.use('/v1/coupons', couponRoutes);
  app.use('/v1/kyc', kycRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
