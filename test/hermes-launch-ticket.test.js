const test = require('node:test');
const assert = require('node:assert');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { buildDashboardUrl, HERMES_TICKET_USERNAME } = require('../src/routes/hermes');
const { hashTicket } = require('../src/services/hermesAccounts');

const userId = '6a69f0cdd7faa829b87a852e';

test('Hermes launch URL carries a fragment ticket, never username/password', () => {
  const url = buildDashboardUrl({ uiBaseUrl: `https://${userId}.hermes.aimarkets.vn`, userId, ticket: 'T'.repeat(43) });
  const u = new URL(url);
  assert.strictEqual(u.pathname, '/login');
  assert.strictEqual(u.searchParams.get('password'), null);
  assert.strictEqual(u.searchParams.get('username'), null);
  assert.strictEqual(u.searchParams.get('ticket'), null, 'ticket must not be in the query string');
  assert.strictEqual(new URLSearchParams(u.hash.slice(1)).get('ticket'), 'T'.repeat(43));
  assert.strictEqual(u.searchParams.get('autoLogin'), 'true');
  assert.ok(u.searchParams.get('next').startsWith('/?'));
});

test('ignores credentials even if a caller still passes them', () => {
  const url = buildDashboardUrl({ uiBaseUrl: 'https://x.hermes.aimarkets.vn', userId, username: 'u', password: 'p' });
  assert.ok(!/password|username/.test(url));
});

test('tickets are stored hashed', () => {
  assert.match(hashTicket('abc'), /^[a-f0-9]{64}$/);
  assert.notStrictEqual(hashTicket('abc'), 'abc');
  assert.strictEqual(HERMES_TICKET_USERNAME, '__aimarkets_ticket__');
});
