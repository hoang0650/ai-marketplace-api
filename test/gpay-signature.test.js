const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  buildSignatureInput,
  buildCreateVirtualAccountInput,
  buildBalanceWebhookInput,
  normalizePrivateKey,
  verifyWebhookSignature,
} = require('../src/utils/gpay-client');

test('buildSignatureInput joins fields as k=v with & in order', () => {
  const input = buildSignatureInput({ merchant_code: 'M_X', order_id: '1', amount: 10 });
  assert.equal(input, 'merchant_code=M_X&order_id=1&amount=10');
});

test('buildSignatureInput renders missing values as empty (no undefined)', () => {
  const input = buildSignatureInput({ a: undefined, b: null, c: 'x' });
  assert.equal(input, 'a=&b=&c=x');
});

test('create-VA input matches the documented field order', () => {
  const input = buildCreateVirtualAccountInput({
    merchantCode: 'MERCHANT_XYZ',
    accountName: 'NGUYEN VAN A',
    mapId: '123456789',
    mapType: 'CMND',
    accountType: 'O',
    bankCode: 'MSB',
  });
  assert.equal(
    input,
    'merchant_code=MERCHANT_XYZ&account_name=NGUYEN VAN A&map_id=123456789&map_type=CMND&account_type=O&bank_code=MSB',
  );
});

test('balance webhook input matches the documented field order', () => {
  const input = buildBalanceWebhookInput({
    gpay_trans_id: 'GPOS1',
    bank_trace_id: 'T1',
    bank_transaction_id: 'B1',
    account_number: '99800020000000000087',
    amount: 1000000,
    message: 'testing transfer',
    action: 'CHANGE_BALANCE',
  });
  assert.equal(
    input,
    'gpay_trans_id=GPOS1&bank_trace_id=T1&bank_transaction_id=B1&account_number=99800020000000000087&amount=1000000&message=testing transfer&action=CHANGE_BALANCE',
  );
});

test('normalizePrivateKey converts \\n-escaped single-line values', () => {
  const single = '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----';
  assert.equal(normalizePrivateKey(single), single.replace(/\\n/g, '\n'));
  const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
  assert.equal(normalizePrivateKey(pem), pem);
});

test('verifyWebhookSignature validates a real RSA-SHA256 signature', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const payload = {
    gpay_trans_id: 'GPOS1234567890',
    bank_trace_id: '12345678yuxl',
    bank_transaction_id: '112344234zyx',
    account_number: '99800020000000000087',
    amount: 1000000,
    message: 'testing transfer',
    action: 'CHANGE_BALANCE',
  };
  const input = buildBalanceWebhookInput(payload);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64');

  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  const config = require('../src/config/env');
  const prev = { priv: config.gpayPrivateKey, pub: config.gpayPublicKey };
  config.gpayPrivateKey = privatePem;
  config.gpayPublicKey = publicPem;

  try {
    assert.equal(verifyWebhookSignature({ ...payload, signature }), true);
    // Tampering with the amount must invalidate the signature.
    assert.equal(verifyWebhookSignature({ ...payload, amount: 9, signature }), false);
    assert.equal(verifyWebhookSignature({ ...payload }), false);
  } finally {
    config.gpayPrivateKey = prev.priv;
    config.gpayPublicKey = prev.pub;
  }
});

test('close-account webhook uses its own signature input', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const payload = { account_number: '99800020000000000087', message: 'testing close', action: 'CLOSE_ACCOUNT' };
  const input = buildSignatureInput({
    account_number: payload.account_number,
    message: payload.message,
    action: payload.action,
  });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64');

  const config = require('../src/config/env');
  const prev = { pub: config.gpayPublicKey };
  config.gpayPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
  try {
    assert.equal(verifyWebhookSignature({ ...payload, signature }), true);
  } finally {
    config.gpayPublicKey = prev.pub;
  }
});
