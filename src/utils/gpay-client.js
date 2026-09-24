const crypto = require('crypto');
const config = require('../config/env');

/**
 * GPay Payment Platform client.
 *
 * Two separate environments (per GPAY technical specs):
 *  - Virtual Account (top-up): mpa-va…  → customers transfer VND into a VA
 *    allocated per user; GPay calls our webhook on every credit.
 *  - Pay-on-behalf (payout):   mpa…     → wallet-to-bank transfers.
 *
 * Auth is two-layered: an access token (merchant_code + password) plus a
 * Digital Signature — RSA/SHA-256 over `k1=v1&k2=v2…`, base64 encoded.
 */

const VA_SANDBOX_BASE = 'https://mpa-va.sandbox.g-pay.vn/api/v3';
const VA_LIVE_BASE = 'https://mpa-va.g-pay.vn/api/v3';
const POB_SANDBOX_BASE = 'https://mpa.sandbox.g-pay.vn/api/v3';
const POB_LIVE_BASE = 'https://mpa.g-pay.vn/api/v3';

function gpayEnabled() {
  return Boolean(config.gpayMerchantCode && config.gpayPassword);
}

/** VA only needs merchant code + password (+ signature key for live). */
function gpayVaEnabled() {
  if (!config.gpayVaEnabled) return false;
  return Boolean(config.gpayMerchantCode && config.gpayPassword && gpayPrivateKey());
}

function gpaySandbox() {
  return config.gpaySandbox !== false;
}

function vaBase() {
  return gpaySandbox() ? VA_SANDBOX_BASE : VA_LIVE_BASE;
}

function pobBase() {
  return gpaySandbox() ? POB_SANDBOX_BASE : POB_LIVE_BASE;
}

function normalizePrivateKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  // Support both a real PEM and a base64/`\n`-escaped single-line env var.
  const withNewlines = value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
  if (withNewlines.includes('-----BEGIN')) return withNewlines;
  try {
    const decoded = Buffer.from(withNewlines, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded;
  } catch {
    /* ignore */
  }
  return withNewlines;
}

function gpayPrivateKey() {
  return normalizePrivateKey(config.gpayPrivateKey);
}

function gpayPublicKey() {
  return normalizePrivateKey(config.gpayPublicKey);
}

/** `k1=v1&k2=v2` in the exact order given (spec-defined per API). */
function buildSignatureInput(fields) {
  return Object.keys(fields)
    .map((key) => `${key}=${fields[key] === undefined || fields[key] === null ? '' : fields[key]}`)
    .join('&');
}

function signInput(input) {
  const key = gpayPrivateKey();
  if (!key) {
    const err = new Error('GPay private key is not configured');
    err.status = 503;
    err.code = 'GPAY_NOT_CONFIGURED';
    throw err;
  }
  const signature = crypto.sign('RSA-SHA256', Buffer.from(String(input), 'utf8'), key);
  return signature.toString('base64');
}

/** Create-VA signature input, per spec 3.3.1. */
function buildCreateVirtualAccountInput({ merchantCode, accountName, mapId, mapType, accountType, bankCode }) {
  return buildSignatureInput({
    merchant_code: merchantCode,
    account_name: accountName,
    map_id: mapId,
    map_type: mapType,
    account_type: accountType,
    bank_code: bankCode,
  });
}

/** Balance webhook signature input, per spec 3.3.7.1. */
function buildBalanceWebhookInput(payload = {}) {
  return buildSignatureInput({
    gpay_trans_id: payload.gpay_trans_id,
    bank_trace_id: payload.bank_trace_id,
    bank_transaction_id: payload.bank_transaction_id,
    account_number: payload.account_number,
    amount: payload.amount,
    message: payload.message,
    action: payload.action,
  });
}

/** Verify a signature produced by GPay using their public key. */
function verifyWebhookSignature(payload = {}) {
  const provided = String(payload.signature || '').trim();
  if (!provided) return false;
  const publicKey = gpayPublicKey();
  if (!publicKey) {
    // No key configured: only trust when explicitly allowed (sandbox/simulation).
    return gpaySandbox() && config.gpayTrustUnsignedWebhook === true;
  }
  const action = String(payload.action || '').trim();
  const input = action === 'CLOSE_ACCOUNT'
    ? buildSignatureInput({
      account_number: payload.account_number,
      message: payload.message,
      action: payload.action,
    })
    : buildBalanceWebhookInput(payload);
  try {
    return crypto.verify('RSA-SHA256', Buffer.from(input, 'utf8'), publicKey, Buffer.from(provided, 'base64'));
  } catch {
    return false;
  }
}

let tokenCache = { token: '', expiresAt: 0 };

function resetTokenCache() {
  tokenCache = { token: '', expiresAt: 0 };
}

async function getAccessToken() {
  if (!gpayEnabled()) {
    const err = new Error('GPay credentials not configured');
    err.status = 503;
    err.code = 'GPAY_NOT_CONFIGURED';
    throw err;
  }
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 30_000) return tokenCache.token;

  const res = await fetch(`${vaBase()}/authentication/token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      merchant_code: config.gpayMerchantCode,
      password: config.gpayPassword,
    }),
  });
  const data = await res.json().catch(() => ({}));
  const code = String(data?.meta?.code ?? '');
  const token = data?.response?.token;
  if (!res.ok || code !== '200' || !token) {
    const err = new Error(data?.meta?.msg || data?.meta?.internal_msg || 'GPay auth failed');
    err.status = 502;
    err.code = 'GPAY_AUTH_FAILED';
    err.detail = data;
    throw err;
  }
  const expiresAt = Date.parse(data?.response?.expired_at || '') || now + 55 * 60_000;
  tokenCache = { token, expiresAt };
  return token;
}

async function gpayVaFetch(path, body = {}, { method = 'POST' } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${vaBase()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const code = String(data?.meta?.code ?? '');
  if (!res.ok || code !== '200') {
    const err = new Error(data?.meta?.msg || data?.meta?.internal_msg || 'GPay request failed');
    err.status = res.status >= 400 && res.status < 500 ? res.status : 502;
    err.code = 'GPAY_REQUEST_FAILED';
    err.detail = data;
    throw err;
  }
  return data;
}

/** Create a VND collection account for a user (spec 3.3.1). */
async function createVirtualAccount({ accountName, mapId, mapType = 'CUSTOMER_ID', accountType = 'M', bankCode = 'VCCB' }) {
  const input = buildCreateVirtualAccountInput({
    merchantCode: config.gpayMerchantCode,
    accountName,
    mapId,
    mapType,
    accountType,
    bankCode,
  });
  const data = await gpayVaFetch('/virtual-account/create', {
    merchant_code: config.gpayMerchantCode,
    account_name: accountName,
    map_id: mapId,
    map_type: mapType,
    account_type: accountType,
    bank_code: bankCode,
    signature: signInput(input),
  });
  return data.response || {};
}

async function queryVirtualAccount(accountNumber) {
  const input = buildSignatureInput({
    merchant_code: config.gpayMerchantCode,
    account_number: accountNumber,
  });
  const data = await gpayVaFetch('/virtual-account/detail', {
    merchant_code: config.gpayMerchantCode,
    account_number: accountNumber,
    bank_code: config.gpayVaBankCode,
    signature: signInput(input),
  });
  return data.response || {};
}

/** Deposit webhook URL on our side, e.g. https://api.aimarkets.vn/v1/gpay/webhook. */
function webhookUrl() {
  const base = String(config.apiPublicUrl || config.frontendUrl || '').replace(/\/+$/, '');
  return `${base}/v1/gpay/webhook`;
}

module.exports = {
  VA_SANDBOX_BASE,
  VA_LIVE_BASE,
  POB_SANDBOX_BASE,
  POB_LIVE_BASE,
  gpayEnabled,
  gpayVaEnabled,
  gpaySandbox,
  vaBase,
  pobBase,
  normalizePrivateKey,
  buildSignatureInput,
  buildCreateVirtualAccountInput,
  buildBalanceWebhookInput,
  signInput,
  verifyWebhookSignature,
  resetTokenCache,
  getAccessToken,
  gpayVaFetch,
  createVirtualAccount,
  queryVirtualAccount,
  webhookUrl,
};
