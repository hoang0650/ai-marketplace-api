const crypto = require('crypto');
const config = require('../config/env');
const { publicApiBase } = require('../config/googleAuth');
const { GPAY_PUBLIC_KEY_SANDBOX, GPAY_PUBLIC_KEY_PRODUCT } = require('../config/gpayKeys');

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

// Virtual Account + QR Payment share the mpa-va host. The QR spec lists
// mpa-va.sandbox.g-pay.vn, which has no DNS record; GPAY_VA_BASE_URL overrides.
const VA_SANDBOX_BASE = 'https://mpa-va-sandbox.g-pay.vn/api/v3';
const VA_LIVE_BASE = 'https://mpa-va.g-pay.vn/api/v3';
const POB_SANDBOX_BASE = 'https://mpa-sandbox.g-pay.vn/api/v3';
const POB_LIVE_BASE = 'https://mpa.g-pay.vn/api/v3';
// Payment gateway ("1 cổng": ATM / international card / VA on GPay's page).
const PORTAL_SANDBOX_BASE = 'https://payment-sandbox.g-pay.vn/api/v4';
const PORTAL_LIVE_BASE = 'https://payment.g-pay.vn/api/v4';

function gpayEnabled() {
  return Boolean(config.gpayMerchantCode && config.gpayPassword);
}

function gpayPortalEnabled() {
  if (!config.gpayVaEnabled) return false;
  return Boolean(config.gpayPortalMerchantCode && config.gpayPortalPassword && gpayPrivateKey());
}

function portalBase() {
  return config.gpayPortalBaseUrl || (gpaySandbox() ? PORTAL_SANDBOX_BASE : PORTAL_LIVE_BASE);
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
  return config.gpayVaBaseUrl || (gpaySandbox() ? VA_SANDBOX_BASE : VA_LIVE_BASE);
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
  return (
    normalizePrivateKey(config.gpayPublicKey) ||
    (gpaySandbox() ? GPAY_PUBLIC_KEY_SANDBOX : GPAY_PUBLIC_KEY_PRODUCT)
  );
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

/** Gateway webhook + bill-info response (portal spec). */
function buildPortalWebhookInput(payload = {}) {
  return buildSignatureInput({
    merchant_order_id: payload.merchant_order_id,
    gpay_trans_id: payload.gpay_trans_id,
    gpay_bill_id: payload.gpay_bill_id,
    status: payload.status,
    embed_data: payload.embed_data,
    user_payment_method: payload.user_payment_method,
  });
}

/**
 * QR webhook. The spec's INPUT line was copied from the VA spec (it names
 * transaction_id/bank_trace_id/account_number/action, which QR payloads don't
 * carry), so accept the documented form and the payload's own field order.
 */
function buildQrWebhookInputs(payload = {}) {
  return [
    buildSignatureInput({
      transaction_id: payload.transaction_id ?? payload.gpay_trans_id,
      bank_trace_id: payload.bank_trace_id,
      bank_transaction_id: payload.bank_transaction_id,
      account_number: payload.account_number,
      amount: payload.amount,
      message: payload.message,
      action: payload.action,
    }),
    buildBalanceWebhookInput(payload),
    buildSignatureInput({
      gpay_trans_id: payload.gpay_trans_id,
      bank_transaction_id: payload.bank_transaction_id,
      amount: payload.amount,
      message: payload.message,
      merchant_code: payload.merchant_code,
      terminal_id: payload.terminal_id,
      source_of_fund: payload.source_of_fund,
      store_code: payload.store_code,
      qr_type: payload.qr_type,
      bill_id: payload.bill_id,
    }),
  ];
}

/** Which GPay product sent this webhook: 'portal' | 'qr' | 'va'. */
function detectWebhookKind(payload = {}) {
  if (payload.gpay_bill_id || payload.merchant_order_id) return 'portal';
  if (payload.qr_type || (payload.bill_id && !payload.account_number)) return 'qr';
  return 'va';
}

/** Verify a signature produced by GPay using their public key (any product). */
function verifyWebhookSignature(payload = {}) {
  const provided = String(payload.signature || '').trim();
  if (!provided) return false;
  const publicKey = gpayPublicKey();
  const kind = detectWebhookKind(payload);
  let inputs;
  if (kind === 'portal') inputs = [buildPortalWebhookInput(payload)];
  else if (kind === 'qr') inputs = buildQrWebhookInputs(payload);
  else if (String(payload.action || '').trim().toUpperCase() === 'CLOSE_ACCOUNT') {
    inputs = [buildSignatureInput({
      account_number: payload.account_number,
      message: payload.message,
      action: payload.action,
    })];
  } else inputs = [buildBalanceWebhookInput(payload)];
  return inputs.some((input) => {
    try {
      return crypto.verify('RSA-SHA256', Buffer.from(input, 'utf8'), publicKey, Buffer.from(provided, 'base64'));
    } catch {
      return false;
    }
  });
}

const tokenCache = new Map();

/** QR returns `expired_at` as RFC 3339; the gateway documents a UTC timestamp. */
function tokenExpiresAt(raw, now = Date.now()) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  return Date.parse(raw || '') || now + 55 * 60_000;
}

function resetTokenCache() {
  tokenCache.clear();
}

function vaCreds() {
  return { base: vaBase(), merchantCode: config.gpayMerchantCode, password: config.gpayPassword };
}

function portalCreds() {
  return { base: portalBase(), merchantCode: config.gpayPortalMerchantCode, password: config.gpayPortalPassword };
}

async function getAccessToken(creds = vaCreds()) {
  if (!creds.merchantCode || !creds.password) {
    const err = new Error('GPay credentials not configured');
    err.status = 503;
    err.code = 'GPAY_NOT_CONFIGURED';
    throw err;
  }
  const cacheKey = `${creds.base}|${creds.merchantCode}`;
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 30_000) return cached.token;

  const res = await fetch(`${creds.base}/authentication/token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      merchant_code: creds.merchantCode,
      password: creds.password,
    }),
  });
  const data = await res.json().catch(() => ({}));
  const code = String(data?.meta?.code ?? '');
  const token = data?.response?.token;
  if (!res.ok || code !== '200' || !token) {
    const reason = data?.meta?.msg ? String(data.meta.msg).trim() : `HTTP ${res.status}`;
    const err = new Error(`GPay auth failed (${reason})`);
    err.status = 502;
    err.code = 'GPAY_AUTH_FAILED';
    err.detail = { base: creds.base, sandbox: gpaySandbox(), status: res.status, meta: data?.meta };
    if (res.status === 401 || ['401', '51317'].includes(code)) {
      err.detail.hint = `merchant_code/password không hợp lệ cho môi trường ${gpaySandbox() ? 'sandbox' : 'production'} của GPay`;
      if (creds.base === portalBase() && config.gpayPortalCredsShared) {
        err.detail.hint += '; cổng thanh toán đang dùng chung GPAY_MERCHANT_CODE — đặt GPAY_PORTAL_MERCHANT_CODE / GPAY_PORTAL_PASSWORD';
      }
    }
    throw err;
  }
  tokenCache.set(cacheKey, { token, expiresAt: tokenExpiresAt(data?.response?.expired_at, now) });
  return token;
}

async function gpayVaFetch(path, body = {}, { method = 'POST', creds = vaCreds() } = {}) {
  const token = await getAccessToken(creds);
  const res = await fetch(`${creds.base}${path}`, {
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

/**
 * Payment gateway: create a bill and get `bill_url` to redirect the payer to.
 * GPay posts the result to the PHHotel webhook, which relays `AIM…` orders here.
 */
async function initBill({ requestId, amountVnd, customerId, customerName, title, description, callbackUrl, embedData }) {
  const signed = {
    merchant_code: config.gpayPortalMerchantCode,
    request_id: requestId,
    amount: Math.round(Number(amountVnd) || 0),
    customer_id: String(customerId || '').slice(0, 20),
    payment_method: config.gpayPortalPaymentMethod,
    embed_data: embedData || '',
  };
  const body = {
    ...signed,
    title: title || undefined,
    description: description || undefined,
    customer_name: customerName || undefined,
    callback_url: callbackUrl,
    webhook_url: webhookUrl(),
    payment_type: 'IMMEDIATE',
    signature: signInput(buildSignatureInput(signed)),
  };
  if (!body.payment_method) delete body.payment_method;
  const data = await gpayVaFetch('/init-bill', body, { creds: portalCreds() });
  return data.response || {};
}

/** Payment gateway: current status of a bill (signed like the webhook). */
async function getBillInfo({ merchantOrderId, gpayBillId }) {
  const signed = {
    merchant_code: config.gpayPortalMerchantCode,
    merchant_order_id: merchantOrderId,
    gpay_bill_id: gpayBillId,
  };
  const data = await gpayVaFetch(
    '/bill-info',
    { ...signed, signature: signInput(buildSignatureInput(signed)) },
    { creds: portalCreds() },
  );
  return data.response || {};
}

/** QR Payment: dynamic VietQR for one bill; bill_id comes back in the webhook. */
async function createQrPayment({ billId, amountVnd, accountName, description }) {
  const signed = {
    merchant_code: config.gpayMerchantCode,
    account_name: String(accountName || 'AI MARKETS').slice(0, 50),
    qr_type: 'DYNAMIC',
    source_of_fund: config.gpayQrSourceOfFund,
    bill_id: billId,
  };
  const body = {
    ...signed,
    amount: Math.round(Number(amountVnd) || 0),
    description: String(description || billId).slice(0, 30),
    signature: signInput(buildSignatureInput(signed)),
  };
  if (config.gpayQrTerminalId) body.terminal_id = config.gpayQrTerminalId;
  if (config.gpayQrStoreCode) body.store_code = config.gpayQrStoreCode;
  if (!body.source_of_fund) delete body.source_of_fund;
  const data = await gpayVaFetch('/qr-payment/create', body);
  return data.response || {};
}

/**
 * Relayed webhooks from phhotel-api carry `X-GPay-Relay-Secret`. When the
 * secret is configured, only the relay may call /v1/gpay/webhook.
 */
function verifyRelaySecret(provided) {
  const expected = String(config.gpayRelaySecret || '');
  if (!expected) return true;
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** URL registered with GPay (phhotel-api owns the merchant contract). */
function webhookUrl(req) {
  if (config.gpayWebhookUrl) return config.gpayWebhookUrl;
  let base = String(config.apiPublicUrl || '').trim();
  if (!base && req) base = publicApiBase(req);
  if (!base) base = String(config.frontendUrl || '');
  return `${base.replace(/\/+$/, '')}/v1/gpay/webhook`;
}

module.exports = {
  VA_SANDBOX_BASE,
  VA_LIVE_BASE,
  POB_SANDBOX_BASE,
  POB_LIVE_BASE,
  PORTAL_SANDBOX_BASE,
  PORTAL_LIVE_BASE,
  gpayEnabled,
  gpayVaEnabled,
  gpayPortalEnabled,
  gpaySandbox,
  vaBase,
  pobBase,
  portalBase,
  normalizePrivateKey,
  buildSignatureInput,
  buildCreateVirtualAccountInput,
  buildBalanceWebhookInput,
  buildPortalWebhookInput,
  buildQrWebhookInputs,
  detectWebhookKind,
  signInput,
  verifyWebhookSignature,
  verifyRelaySecret,
  tokenExpiresAt,
  resetTokenCache,
  getAccessToken,
  gpayVaFetch,
  createVirtualAccount,
  queryVirtualAccount,
  initBill,
  getBillInfo,
  createQrPayment,
  webhookUrl,
};
