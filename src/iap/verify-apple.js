const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { IOS_BUNDLE_ID } = require('./constants');
const { pemFromEnv } = require('./parse-json-env');

const LIVE_TX = 'https://api.storekit.itunes.apple.com/inApps/v1/transactions';
const SANDBOX_TX = 'https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions';

function appleConfigured() {
  return Boolean(config.appleIapIssuerId && config.appleIapKeyId && config.appleIapPrivateKey)
    || Boolean(config.appleIapSharedSecret);
}

function looksLikeJws(value) {
  const parts = String(value || '').split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function looksLikeAppleReceipt(value) {
  const s = String(value || '');
  return s.length > 80 && !s.includes('.');
}

function decodeJwsPayload(jws) {
  const parts = String(jws).split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function verifyJwsSignature(jws) {
  const parts = String(jws).split('.');
  if (parts.length !== 3) return false;
  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  const leaf = header?.x5c?.[0];
  if (!leaf) return false;
  const pem = `-----BEGIN CERTIFICATE-----\n${leaf.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  try {
    return crypto.createVerify('SHA256').update(`${parts[0]}.${parts[1]}`).verify(pem, parts[2], 'base64url');
  } catch {
    return false;
  }
}

function matchApplePayload(payload, { productId, transactionId }) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'IAP_APPLE_PAYLOAD', message: 'Apple transaction payload missing' };
  }
  if (payload.revocationDate) {
    return { ok: false, code: 'IAP_APPLE_REVOKED', message: 'Apple transaction was revoked' };
  }
  if (payload.bundleId && payload.bundleId !== IOS_BUNDLE_ID) {
    return { ok: false, code: 'IAP_APPLE_BUNDLE', message: 'Apple bundleId does not match AI Markets' };
  }
  if (String(payload.productId || '') !== productId) {
    return { ok: false, code: 'IAP_APPLE_SKU', message: 'Apple productId does not match pack' };
  }
  const storeTx = String(payload.transactionId || payload.originalTransactionId || '');
  if (transactionId && storeTx && storeTx !== String(transactionId)) {
    return { ok: false, code: 'IAP_APPLE_TX', message: 'Apple transactionId does not match' };
  }
  return { ok: true, transactionId: storeTx || transactionId, environment: payload.environment || '' };
}

function appStoreApiJwt() {
  const key = pemFromEnv(config.appleIapPrivateKey);
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: config.appleIapIssuerId,
      iat: now,
      exp: now + 20 * 60,
      aud: 'appstoreconnect-v1',
      bid: config.appleIapBundleId || IOS_BUNDLE_ID,
    },
    key,
    { algorithm: 'ES256', keyid: config.appleIapKeyId },
  );
}

async function fetchAppleTransaction(transactionId) {
  const token = appStoreApiJwt();
  const headers = { Authorization: `Bearer ${token}` };
  let res = await fetch(`${LIVE_TX}/${encodeURIComponent(transactionId)}`, { headers });
  if (res.status === 404 || res.status === 400) {
    res = await fetch(`${SANDBOX_TX}/${encodeURIComponent(transactionId)}`, { headers });
  }
  if (!res.ok) {
    return { ok: false, code: 'IAP_APPLE_API', message: `App Store Server API ${res.status}` };
  }
  const json = await res.json();
  const jws = json.signedTransactionInfo;
  if (!looksLikeJws(jws)) {
    return { ok: false, code: 'IAP_APPLE_API', message: 'App Store Server API returned no signed transaction' };
  }
  if (!verifyJwsSignature(jws)) {
    return { ok: false, code: 'IAP_APPLE_JWS_SIG', message: 'Apple signed transaction signature invalid' };
  }
  return { ok: true, payload: decodeJwsPayload(jws) };
}

async function verifyAppleReceipt(receiptData) {
  const body = {
    'receipt-data': receiptData,
    password: config.appleIapSharedSecret,
    'exclude-old-transactions': true,
  };
  const post = (url) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  let json = await post('https://buy.itunes.apple.com/verifyReceipt');
  if (json.status === 21007) {
    json = await post('https://sandbox.itunes.apple.com/verifyReceipt');
  }
  if (json.status !== 0) {
    return { ok: false, code: 'IAP_APPLE_STATUS', message: `Apple verifyReceipt status ${json.status}` };
  }
  return { ok: true, receipt: json.receipt, latest_receipt_info: json.latest_receipt_info };
}

async function verifyAppleIap({ productId, transactionId, purchaseToken, signedTransaction }) {
  const jws = looksLikeJws(signedTransaction) ? signedTransaction
    : looksLikeJws(purchaseToken) ? purchaseToken
      : '';

  if (jws) {
    if (!verifyJwsSignature(jws)) {
      return { ok: false, code: 'IAP_APPLE_JWS_SIG', message: 'Apple JWS signature invalid' };
    }
    return matchApplePayload(decodeJwsPayload(jws), { productId, transactionId });
  }

  if (config.appleIapIssuerId && config.appleIapKeyId && config.appleIapPrivateKey && transactionId) {
    const fetched = await fetchAppleTransaction(transactionId);
    if (!fetched.ok) return fetched;
    return matchApplePayload(fetched.payload, { productId, transactionId });
  }

  if (config.appleIapSharedSecret && looksLikeAppleReceipt(purchaseToken)) {
    const result = await verifyAppleReceipt(purchaseToken);
    if (!result.ok) return result;
    const inApp = result.receipt?.in_app || result.latest_receipt_info || [];
    const rows = Array.isArray(inApp) ? inApp : [];
    const hit = rows.find(
      (row) =>
        String(row.product_id) === productId
        && String(row.transaction_id || row.original_transaction_id) === String(transactionId),
    );
    if (!hit && rows.length) {
      return { ok: false, code: 'IAP_APPLE_MISMATCH', message: 'Apple receipt does not match product' };
    }
    return { ok: true, transactionId, environment: result.receipt?.receipt_type || '' };
  }

  return {
    ok: false,
    code: 'IAP_NOT_CONFIGURED',
    message: 'Apple IAP is not configured (App Store Server API key or shared secret + receipt)',
  };
}

module.exports = {
  appleConfigured,
  decodeJwsPayload,
  looksLikeJws,
  matchApplePayload,
  verifyAppleIap,
  verifyJwsSignature,
};
