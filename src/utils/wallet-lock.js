'use strict';

const crypto = require('crypto');
const WalletLock = require('../models/WalletLock');

const LOCK_TTL_MS = 15_000;
const WAIT_MS = 8_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function busyError() {
  const err = new Error('Wallet is busy, please retry');
  err.status = 503;
  err.code = 'WALLET_BUSY';
  return err;
}

/**
 * Serialize balance-check + debit for one user across requests and replicas.
 * Acquire = conditional upsert on an expired/missing row; a live row makes the upsert
 * collide on `_id` (E11000) and we back off. Released by token so a slow holder whose
 * lease expired can never free someone else's lock.
 */
async function acquireWalletLock(userId, { ttlMs = LOCK_TTL_MS, waitMs = WAIT_MS } = {}) {
  const key = String(userId);
  const token = crypto.randomBytes(12).toString('hex');
  const deadline = Date.now() + waitMs;
  let delay = 15;
  for (;;) {
    const now = new Date();
    try {
      await WalletLock.findOneAndUpdate(
        { _id: key, until: { $lt: now } },
        { $set: { token, until: new Date(now.getTime() + ttlMs) } },
        { upsert: true, new: true }
      );
      return { key, token };
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    if (Date.now() >= deadline) throw busyError();
    await sleep(delay + Math.floor(Math.random() * delay));
    delay = Math.min(250, delay * 2);
  }
}

async function releaseWalletLock(lock) {
  if (!lock) return;
  await WalletLock.deleteOne({ _id: lock.key, token: lock.token }).catch(() => {});
}

async function withWalletLock(userId, fn, opts) {
  const lock = await acquireWalletLock(userId, opts);
  try {
    return await fn();
  } finally {
    await releaseWalletLock(lock);
  }
}

module.exports = { acquireWalletLock, releaseWalletLock, withWalletLock, LOCK_TTL_MS };
