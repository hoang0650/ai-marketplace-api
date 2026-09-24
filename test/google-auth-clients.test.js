const test = require('node:test');
const assert = require('node:assert/strict');

const WEB = 'web-123.apps.googleusercontent.com';
const IOS = 'ios-456.apps.googleusercontent.com';
const ANDROID = 'android-789.apps.googleusercontent.com';

process.env.GOOGLE_CLIENT_ID = WEB;
process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-test';
process.env.GOOGLE_IOS_CLIENT_ID = IOS;
process.env.GOOGLE_ANDROID_CLIENT_ID = ANDROID;

const { resolveGoogleCodeExchangeCredentials, getGoogleClientIds } = require('../src/config/googleAuth');

test('all three client ids are accepted as ID token audiences', () => {
  assert.deepEqual(getGoogleClientIds().sort(), [ANDROID, IOS, WEB].sort());
});

test('https callback always exchanges with the Web client + secret, even with an Android client set', () => {
  const r = resolveGoogleCodeExchangeCredentials('https://api.aimarkets.vn/v1/auth/google/callback');
  assert.equal(r.clientId, WEB);
  assert.equal(r.clientSecret, 'GOCSPX-test');
});

test('postmessage (web popup) uses the Web client + secret', () => {
  const r = resolveGoogleCodeExchangeCredentials('postmessage');
  assert.equal(r.clientId, WEB);
  assert.equal(r.clientSecret, 'GOCSPX-test');
});

test('iOS reverse-client-id redirect uses the iOS public client without a secret', () => {
  const r = resolveGoogleCodeExchangeCredentials('com.googleusercontent.apps.ios-456:/oauthredirect', IOS);
  assert.equal(r.clientId, IOS);
  assert.equal(r.clientSecret, null);
});

test('reverse-client-id redirect for an unknown client is rejected', () => {
  assert.throws(() => resolveGoogleCodeExchangeCredentials('com.googleusercontent.apps.evil-1:/oauthredirect'));
});

test('Android client cannot be used for code exchange', () => {
  assert.throws(
    () => resolveGoogleCodeExchangeCredentials('https://aimarkets.vn/bridge', ANDROID),
    /Android client/,
  );
});

test('unknown explicit client id on https redirect is rejected', () => {
  assert.throws(() => resolveGoogleCodeExchangeCredentials('postmessage', 'other.apps.googleusercontent.com'));
});
