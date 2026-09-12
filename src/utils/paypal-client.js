const config = require('../config/env');

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const LIVE_BASE = 'https://api-m.paypal.com';

function paypalEnabled() {
  return Boolean(config.paypalClientId && config.paypalClientSecret);
}

function paypalBase() {
  return config.paypalSandbox ? SANDBOX_BASE : LIVE_BASE;
}

function toPaypalUsd(amount, currency = 'USD', vndPerUsd = config.paypalVndPerUsd) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const code = String(currency || 'USD').toUpperCase();
  let usd = n;
  if (code === 'VND' || code === 'VNĐ') {
    const rate = Number(vndPerUsd) > 0 ? Number(vndPerUsd) : 26000;
    usd = n / rate;
  } else if (code !== 'USD') {
    return null;
  }
  const rounded = Math.round(usd * 100) / 100;
  if (rounded < 0.01) return null;
  return rounded.toFixed(2);
}

async function getAccessToken() {
  if (!paypalEnabled()) {
    const err = new Error('PayPal credentials not configured');
    err.status = 503;
    err.code = 'PAYPAL_NOT_CONFIGURED';
    throw err;
  }
  const basic = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString('base64');
  const res = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(data?.error_description || 'PayPal auth failed');
    err.status = 502;
    err.detail = data;
    throw err;
  }
  return data.access_token;
}

async function paypalFetch(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${paypalBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || data?.error_description || 'PayPal request failed');
    err.status = res.status >= 400 && res.status < 500 ? res.status : 502;
    err.detail = data;
    throw err;
  }
  return data;
}

function buildCheckoutOrder({ amountUsd, customId, description }) {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: String(customId || `aim_${Date.now()}`).slice(0, 256),
        description: String(description || 'AI Markets wallet').slice(0, 127),
        custom_id: String(customId || '').slice(0, 127),
        amount: { currency_code: 'USD', value: String(amountUsd) },
      },
    ],
    application_context: {
      brand_name: 'AI Markets',
      landing_page: 'NO_PREFERENCE',
      user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
      return_url: `${config.frontendUrl.replace(/\/+$/, '')}/wallet?paymentStatus=success&paymentMethod=paypal`,
      cancel_url: `${config.frontendUrl.replace(/\/+$/, '')}/wallet?paymentStatus=cancel&paymentMethod=paypal`,
    },
  };
}

module.exports = {
  SANDBOX_BASE,
  LIVE_BASE,
  paypalEnabled,
  paypalBase,
  toPaypalUsd,
  getAccessToken,
  paypalFetch,
  buildCheckoutOrder,
};
