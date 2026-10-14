/** Pure helpers for VietQR bank-transfer top-up (no DB) so they are unit-testable. */
const crypto = require('crypto');

const KIND = 'bank_transfer_vietqr';
const NONCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreads

function shortUserId(userId) {
  return String(userId || '').replace(/[^0-9a-fA-F]/g, '').slice(-6).toUpperCase() || 'USER';
}

function randomNonce(len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i += 1) s += NONCE_ALPHABET[bytes[i] % NONCE_ALPHABET.length];
  return s;
}

/** e.g. "AIM 1A2B3C K7QX9M": unique per pending deposit, ASCII, short enough for any bank memo. */
function makeTransferContent(userId, nonce = randomNonce()) {
  return `AIM ${shortUserId(userId)} ${nonce}`;
}

/**
 * Convert the user's input to { amountUsd, amountVnd }.
 * VND is what the user actually transfers (integer, rounded up to 1,000đ);
 * USD credited = VND / rate rounded to cents.
 */
function convertAmount({ amount, currency = 'USD' }, vndPerUsd) {
  const rate = Number(vndPerUsd);
  const n = Number(amount);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid rate');
  if (!Number.isFinite(n) || n <= 0) return null;
  const cur = String(currency || 'USD').toUpperCase();
  let amountVnd;
  if (cur === 'VND') amountVnd = Math.round(n);
  else if (cur === 'USD') amountVnd = Math.round(n * rate);
  else return null;
  amountVnd = Math.ceil(amountVnd / 1000) * 1000;
  const amountUsd = Math.round((amountVnd / rate) * 100) / 100;
  if (amountUsd <= 0) return null;
  return { amountUsd, amountVnd, vndPerUsd: rate };
}

module.exports = { KIND, shortUserId, randomNonce, makeTransferContent, convertAmount };
