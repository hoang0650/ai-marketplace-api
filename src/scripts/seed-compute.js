/**
 * Upsert GPU / game test listings + sandbox nodes without wiping the catalog.
 * Usage: npm run seed:compute
 */
require('dotenv').config();
const { connectDb } = require('../config/db');
const { ensureComputeTestProducts } = require('../utils/ensure-compute-products');

connectDb()
  .then(() => ensureComputeTestProducts())
  .then((r) => {
    console.log('[seed:compute]', r);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[seed:compute] failed', err);
    process.exit(1);
  });
