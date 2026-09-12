#!/usr/bin/env node
/**
 * Register Apple Pay domains with PayPal (required before the button works).
 * Usage:
 *   node src/scripts/register-apple-pay-domain.js
 *   node src/scripts/register-apple-pay-domain.js aimarkets.vn www.aimarkets.vn
 */
require('dotenv').config();
const config = require('../config/env');
const { paypalEnabled, paypalBase, getAccessToken } = require('../utils/paypal-client');

async function register(domain) {
  const token = await getAccessToken();
  const res = await fetch(`${paypalBase()}/v1/customer/wallet-domains`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      provider_type: 'APPLE_PAY',
      domain: { name: domain },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  if (!paypalEnabled()) {
    console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first.');
    process.exit(1);
  }
  const domains = process.argv.slice(2).length
    ? process.argv.slice(2)
    : config.paypalApplePayDomains;
  console.log(`PayPal ${config.paypalSandbox ? 'sandbox' : 'live'} → register Apple Pay domains`);
  for (const domain of domains) {
    const result = await register(domain);
    console.log(domain, result.status, JSON.stringify(result.data));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
