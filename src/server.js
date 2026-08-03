const mongoose = require('mongoose');
const config = require('./config/env');
const { connectDb } = require('./config/db');
const { closeRedis } = require('./config/redis');
const { createApp } = require('./app');

connectDb();

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[ai-marketplace-api] env=${config.nodeEnv} listening on http://localhost:${config.port}`);
  console.log(`[ai-marketplace-api] api base http://localhost:${config.port}/api`);
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
