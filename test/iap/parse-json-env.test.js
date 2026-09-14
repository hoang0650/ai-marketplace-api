const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonEnv, pemFromEnv } = require('../../src/iap/parse-json-env');

describe('IAP env helpers', () => {
  test('parses raw JSON and base64 JSON', () => {
    const obj = { client_email: 'iap@aimarkets.iam.gserviceaccount.com' };
    assert.deepEqual(parseJsonEnv(JSON.stringify(obj)), obj);
    assert.deepEqual(parseJsonEnv(Buffer.from(JSON.stringify(obj)).toString('base64')), obj);
    assert.equal(parseJsonEnv(''), null);
    assert.equal(parseJsonEnv('not-json'), null);
  });

  test('unescapes PEM newlines from Dokploy env', () => {
    const pem = pemFromEnv('-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n');
    assert.match(pem, /BEGIN PRIVATE KEY-----\nABC\n/);
  });
});
