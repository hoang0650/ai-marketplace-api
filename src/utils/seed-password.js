'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

/**
 * Password for accounts created by seed / ensure-* scripts. Never a shared default:
 * SEED_PASSWORD (min 12 chars) when an operator sets one, otherwise a random secret
 * nobody knows (use "Forgot password" or an admin reset to take the account over).
 */
function seedPassword(env = process.env) {
  const fromEnv = String(env.SEED_PASSWORD || '');
  if (fromEnv.length >= 12) return fromEnv;
  return crypto.randomBytes(24).toString('base64url');
}

async function seedPasswordHash(env = process.env, rounds = 10) {
  return bcrypt.hash(seedPassword(env), rounds);
}

module.exports = { seedPassword, seedPasswordHash };
