const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTransferContent, convertAmount, shortUserId, randomNonce } = require('../src/finance/bank-topup-core');
const { buildVietQrPayload, crc16 } = require('../src/utils/vietqr');
const { bankTransferConfig } = require('../src/config/bank-transfer');

test('transfer content format and uniqueness', () => {
  const uid = '665f1c2ab3d4e5f6a7b8c9d0';
  const c = makeTransferContent(uid);
  assert.match(c, /^AIM [0-9A-F]{6} [A-Z2-9]{6}$/);
  assert.equal(shortUserId(uid), 'B8C9D0');
  const seen = new Set();
  for (let i = 0; i < 20000; i += 1) seen.add(makeTransferContent(uid));
  assert.ok(seen.size >= 19990, `too many collisions: ${20000 - seen.size}`);
  assert.equal(randomNonce().length, 6);
});

test('USD -> VND conversion at 26500, exact (no rounding)', () => {
  assert.deepEqual(convertAmount({ amount: 1, currency: 'USD' }, 26500), { amountUsd: 1, amountVnd: 26500, vndPerUsd: 26500 });
  assert.deepEqual(convertAmount({ amount: 1.01, currency: 'USD' }, 26500), { amountUsd: 1.01, amountVnd: 26765, vndPerUsd: 26500 });
  assert.deepEqual(convertAmount({ amount: 10, currency: 'USD' }, 26500), { amountUsd: 10, amountVnd: 265000, vndPerUsd: 26500 });
  assert.deepEqual(convertAmount({ amount: 1.5, currency: 'USD' }, 26500), { amountUsd: 1.5, amountVnd: 39750, vndPerUsd: 26500 });
});

test('VND -> USD conversion', () => {
  assert.deepEqual(convertAmount({ amount: 26500, currency: 'VND' }, 26500), { amountUsd: 1, amountVnd: 26500, vndPerUsd: 26500 });
  assert.deepEqual(convertAmount({ amount: 12345, currency: 'VND' }, 26500), { amountUsd: 0.47, amountVnd: 12345, vndPerUsd: 26500 });
  assert.deepEqual(convertAmount({ amount: 530000, currency: 'VND' }, 26500), { amountUsd: 20, amountVnd: 530000, vndPerUsd: 26500 });
  assert.deepEqual(convertAmount({ amount: 100000, currency: 'vnd' }, 26500), { amountUsd: 3.77, amountVnd: 100000, vndPerUsd: 26500 });
});

test('invalid amounts rejected', () => {
  for (const a of [0, -5, 'abc', NaN, null]) assert.equal(convertAmount({ amount: a, currency: 'USD' }, 26500), null);
  assert.equal(convertAmount({ amount: 10, currency: 'EUR' }, 26500), null);
});

test('config reads env, default rate 26500, no hardcoded account', () => {
  const off = bankTransferConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.vndPerUsd, 26500);
  assert.equal(off.accountNumber, '');
  const on = bankTransferConfig({ BANK_ACCOUNT: '123456789', BANK_ACCOUNT_NAME: 'cong ty abc', BANK_BIN: '970432', VND_USD_RATE: '25000' });
  assert.equal(on.enabled, true);
  assert.equal(on.accountName, 'CONG TY ABC');
  assert.equal(on.vndPerUsd, 25000);
});

test('VietQR payload: EMV structure + valid CRC', () => {
  const p = buildVietQrPayload({ bin: '970432', accountNumber: '123456789', amountVnd: 265000, content: 'AIM B8C9D0 K7QX9M' });
  assert.ok(p.startsWith('000201010212'));
  assert.ok(p.includes('0010A000000727'));
  assert.ok(p.includes('0006970432'));
  assert.ok(p.includes('0109123456789'));
  assert.ok(p.includes('0208QRIBFTTA'));
  assert.ok(p.includes('5303704'));
  assert.ok(p.includes('5406265000'));
  assert.ok(p.includes('5802VN'));
  assert.ok(p.includes('0817AIM B8C9D0 K7QX9M'));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
  assert.equal(crc16('123456789'), '29B1'); // CRC-16/CCITT-FALSE check value
});

test('credit requires admin (role gate); users have no credit endpoint', () => {
  // Mirror of requireRoles('admin') from middleware/auth.js — buyer/seller cannot credit.
  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ code: 'UNAUTHORIZED' });
    if (String(req.user.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }
    next();
  }
  for (const role of ['buyer', 'seller', 'talent']) {
    let status = 0;
    let passed = false;
    requireAdmin({ user: { role } }, { status(c) { status = c; return this; }, json() { return this; } }, () => { passed = true; });
    assert.equal(status, 403);
    assert.equal(passed, false);
  }
  let passed = false;
  requireAdmin({ user: { role: 'admin' } }, { status() { return this; }, json() { return this; } }, () => { passed = true; });
  assert.equal(passed, true);
  const fs = require('fs');
  const path = require('path');
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/bank-topup.js'), 'utf8');
  const core = fs.readFileSync(path.join(__dirname, '../src/finance/bank-topup-core.js'), 'utf8');
  assert.ok(routes.includes("adminRouter.post('/:id/credit'"));
  assert.ok(routes.includes("requireRoles('admin')"));
  assert.ok(routes.includes('reviewWalletTx'));
  assert.ok(core.includes("bank_transfer_vietqr"));
  // Comment may mention webhook; code must not register or handle one.
  assert.ok(!/app\.post\([^)]*webhook/i.test(routes));
  assert.ok(!/userRouter\.post\([^)]*credit/.test(routes));
});
