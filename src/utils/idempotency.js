'use strict';

const IdempotencyClaim = require('../models/IdempotencyClaim');

const MAX_STORED_BYTES = 256 * 1024;
/** A pending claim older than this is treated as abandoned (crashed request) and can be re-claimed. */
const STALE_PENDING_MS = 10 * 60_000;

function normalizeKey(raw) {
  const key = String(raw ?? '').trim().slice(0, 120);
  return key || null;
}

function conflict() {
  const err = new Error('A request with this Idempotency-Key is still in progress');
  err.status = 409;
  err.code = 'IDEMPOTENCY_IN_PROGRESS';
  err.body = { code: 'IDEMPOTENCY_IN_PROGRESS' };
  return err;
}

/**
 * Claim (buyer, scope, key) before doing any billable work.
 * Returns { state: 'new', claim } | { state: 'replay', claim } and throws 409 while another
 * request with the same key is running. No key → { state: 'none' }.
 */
async function claimIdempotencyKey(buyerId, scope, rawKey) {
  const key = normalizeKey(rawKey);
  if (!key) return { state: 'none', claim: null };
  try {
    const claim = await IdempotencyClaim.create({ buyer: buyerId, scope, key, status: 'pending' });
    return { state: 'new', claim };
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  const existing = await IdempotencyClaim.findOne({ buyer: buyerId, scope, key }).lean();
  if (!existing) return claimIdempotencyKey(buyerId, scope, key);
  if (existing.status === 'done') return { state: 'replay', claim: existing };
  const age = Date.now() - new Date(existing.createdAt || 0).getTime();
  if (age > STALE_PENDING_MS) {
    const taken = await IdempotencyClaim.findOneAndUpdate(
      { _id: existing._id, status: 'pending', createdAt: existing.createdAt },
      { $set: { createdAt: new Date() } },
      { new: true }
    );
    if (taken) return { state: 'new', claim: taken };
  }
  throw conflict();
}

/** Store the response so retries with the same key replay it without re-billing. */
async function completeIdempotencyKey(claim, response, usageEventId = null) {
  if (!claim?._id) return;
  let stored = response;
  try {
    if (Buffer.byteLength(JSON.stringify(response ?? null)) > MAX_STORED_BYTES) stored = { truncated: true };
  } catch {
    stored = { truncated: true };
  }
  await IdempotencyClaim.updateOne(
    { _id: claim._id },
    { $set: { status: 'done', response: stored, usageEvent: usageEventId } }
  ).catch(() => {});
}

/** Failed before billing: free the key so the client may retry. */
async function releaseIdempotencyKey(claim) {
  if (!claim?._id) return;
  await IdempotencyClaim.deleteOne({ _id: claim._id, status: 'pending' }).catch(() => {});
}

module.exports = { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey, normalizeKey };
