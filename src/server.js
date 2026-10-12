const http = require('http');
const mongoose = require('mongoose');
const config = require('./config/env');
const { connectDb } = require('./config/db');
const { closeRedis } = require('./config/redis');
const { createApp } = require('./app');
const { ensureRunpodMarketplaceProducts } = require('./utils/ensure-runpod-products');
const { ensureAiProviderProducts } = require('./utils/ensure-ai-provider-products');
const { ensureComputeTestProducts } = require('./utils/ensure-compute-products');
const { ensureLegalDocuments } = require('./utils/ensure-legal-documents');
const { ensureCommissionRules } = require('./utils/ensure-commission-rules');
const { ensureTaxRules } = require('./utils/ensure-tax-rules');
const { syncSalesCountsFromOrders } = require('./utils/sales');
const { attachTerminalGateway } = require('./terminal/gateway');
const { attachGameStreamProxy } = require('./terminal/stream-proxy');
const { attachGpuWorkspaceProxy } = require('./terminal/gpu-proxy');
const { startBillingWorker, stopBillingWorker } = require('./utils/gpu-rental/service');
const { startGameBillingWorker, stopGameBillingWorker } = require('./utils/game-billing');
const {
  startAgentSubscriptionWorker,
  stopAgentSubscriptionWorker,
} = require('./finance/agent-subscription-worker');

connectDb()
  .then(() => ensureLegalDocuments())
  .then((legal) => {
    if (legal) {
      console.log(
        `[legal] ensured documents version=${legal.version} created=${legal.created} updated=${legal.updated} skipped=${legal.skipped}`,
      );
    }
  })
  .then(() => ensureCommissionRules())
  .then((commission) => {
    if (commission) {
      console.log(`[finance] commission rule ensured rate=${commission.rate} created=${commission.created}`);
    }
  })
  .then(() => ensureTaxRules())
  .then((tax) => {
    if (tax) {
      console.log(`[finance] tax rule ensured rate=${tax.rate} created=${tax.created} updated=${tax.updated}`);
    }
  })
  .then(() => ensureRunpodMarketplaceProducts())
  .then(() => ensureAiProviderProducts())
  .then(() => ensureComputeTestProducts())
  .then(() => syncSalesCountsFromOrders())
  .then((stats) => {
    if (stats) {
      console.log(
        `[sales] synced salesCount from paid orders (${stats.productsWithSales} products)`,
      );
    }
  })
  .catch((err) => console.error('[catalog] ensure marketplace products failed:', err.message));

const app = createApp();
const server = http.createServer(app);
attachTerminalGateway(server);
attachGameStreamProxy(server);
attachGpuWorkspaceProxy(server);
if (process.env.GPU_RENTAL_WORKER !== 'off') startBillingWorker();
if (process.env.GAME_BILLING_WORKER !== 'off') startGameBillingWorker();
if (process.env.AGENT_SUBSCRIPTION_WORKER !== 'off') startAgentSubscriptionWorker();
server.listen(config.port, () => {
  console.log(`[ai-marketplace-api] env=${config.nodeEnv} listening on http://localhost:${config.port}`);
  console.log(`[ai-marketplace-api] api v1 http://localhost:${config.port}/v1`);
  console.log(`[ai-marketplace-api] api v2 http://localhost:${config.port}/v2`);
  console.log(`[ai-marketplace-api] terminal ws  ws://localhost:${config.port}/ws/terminal/:sessionId`);
  console.log(`[ai-marketplace-api] game stream  /v1/game-sessions/:id/player`);
});

server.on('error', (err) => {
  console.error('[ai-marketplace-api] server error:', err);
  process.exit(1);
});

// Graceful shutdown: stop accepting connections, then close DB.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ai-marketplace-api] ${signal} received, shutting down gracefully...`);
  const forceExit = setTimeout(() => {
    console.error('[ai-marketplace-api] forced exit after 10s');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  stopBillingWorker();
  stopGameBillingWorker();
  stopAgentSubscriptionWorker();

  server.close(async () => {
    try {
      await mongoose.connection.close();
    } catch (_) {
      /* already closed */
    }
    await closeRedis();
    console.log('[ai-marketplace-api] shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[ai-marketplace-api] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[ai-marketplace-api] uncaughtException:', err);
  shutdown('uncaughtException');
});
