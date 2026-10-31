const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  buildPortalWebhookInput,
  buildQrWebhookInputs,
  detectWebhookKind,
  verifyWebhookSignature,
} = require('../src/utils/gpay-client');
const { orderRequestId, resolveOrderEvent, settleOrderEvent } = require('../src/finance/gpayOrders');

/** In-memory stand-in for the WalletTx model (only what settleOrderEvent uses). */
function fakeWalletTx(rows) {
  const matches = (row, q) =>
    Object.entries(q).every(([k, v]) => {
      if (k === '_id') return row._id === v;
      if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.includes(row[k]);
      return row[k] === v;
    });
  const apply = (row, set) => {
    for (const [k, v] of Object.entries(set)) {
      if (k.startsWith('meta.')) row.meta = { ...(row.meta || {}), [k.slice(5)]: v };
      else row[k] = v;
    }
  };
  return {
    rows,
    findOne: async (q) => rows.find((r) => matches(r, q)) || null,
    findById: async (id) => rows.find((r) => r._id === id) || null,
    updateOne: async (q, u) => {
      const row = rows.find((r) => matches(r, q));
      if (row) apply(row, u.$set);
    },
    findOneAndUpdate: async (q, u) => {
      const row = rows.find((r) => matches(r, q));
      if (!row) return null;
      apply(row, u.$set);
      return row;
    },
  };
}

function pendingRow(overrides = {}) {
  return {
    _id: 't1',
    gpayRequestId: 'AIMt1',
    status: 'pending',
    amount: 3.85,
    meta: { channel: 'gpay_portal', amountVnd: 100000, vndPerUsd: 26500 },
    ...overrides,
  };
}

test('order ids carry the AIM prefix PHHotel routes on and fit GPay bill_id', () => {
  assert.equal(orderRequestId('65f0c0ffee'), `AIM${(0x65f0c0ffeen).toString(36).toUpperCase()}`);
  const longest = orderRequestId('ffffffffffffffffffffffff');
  assert.match(longest, /^AIM[0-9A-Z]+$/);
  assert.ok(longest.length <= 24, `${longest} is ${longest.length} chars`);
});

test('resolveOrderEvent maps gateway statuses and QR payments', () => {
  const ok = resolveOrderEvent({ gpay_bill_id: 'B', merchant_order_id: 'AIMt1', status: 'ORDER_SUCCESS', gpay_trans_id: 'G' });
  assert.equal(ok.kind, 'portal');
  assert.equal(ok.outcome, 'success');
  assert.equal(ok.requestId, 'AIMt1');
  assert.equal(resolveOrderEvent({ gpay_bill_id: 'B', status: 'ORDER_CANCEL' }).outcome, 'failed');
  assert.equal(resolveOrderEvent({ gpay_bill_id: 'B', status: 'ORDER_PROCESSING' }).outcome, 'pending');
  const qr = resolveOrderEvent({ qr_type: 'DYNAMIC', bill_id: 'AIMt1', amount: 100000, gpay_trans_id: 'Q' });
  assert.equal(qr.kind, 'qr');
  assert.equal(qr.paidVnd, 100000);
  assert.equal(resolveOrderEvent({ account_number: '1', action: 'CHANGE_BALANCE' }), null);
});

test('gateway success completes the pending deposit once', async () => {
  const WalletTx = fakeWalletTx([pendingRow()]);
  const event = resolveOrderEvent({ gpay_bill_id: 'B', merchant_order_id: 'AIMt1', status: 'ORDER_SUCCESS', gpay_trans_id: 'G1' });
  const first = await settleOrderEvent(event, { WalletTx, vndPerUsd: 26500 });
  assert.equal(first.status, 200);
  assert.equal(WalletTx.rows[0].status, 'completed');
  assert.equal(WalletTx.rows[0].gpayTransactionId, 'G1');
  assert.equal(WalletTx.rows[0].amount, 3.85);
  const again = await settleOrderEvent(event, { WalletTx, vndPerUsd: 26500 });
  assert.equal(again.body.duplicate, true);
});

test('gateway failure marks the deposit failed; unknown orders 404', async () => {
  const WalletTx = fakeWalletTx([pendingRow()]);
  await settleOrderEvent(resolveOrderEvent({ gpay_bill_id: 'B', merchant_order_id: 'AIMt1', status: 'ORDER_FAILED' }), {
    WalletTx,
    vndPerUsd: 26500,
  });
  assert.equal(WalletTx.rows[0].status, 'failed');
  const missing = await settleOrderEvent(
    resolveOrderEvent({ gpay_bill_id: 'B', merchant_order_id: 'AIMnope', status: 'ORDER_SUCCESS' }),
    { WalletTx, vndPerUsd: 26500 },
  );
  assert.equal(missing.status, 404);
});

test('settlement keeps the rate stored on the deposit', async () => {
  const WalletTx = fakeWalletTx([pendingRow({ amount: 4, meta: { channel: 'gpay_qr', amountVnd: 100000, vndPerUsd: 25000 } })]);
  const event = resolveOrderEvent({ qr_type: 'DYNAMIC', bill_id: 'AIMt1', amount: 50000, gpay_trans_id: 'Q2' });
  await settleOrderEvent(event, { WalletTx, vndPerUsd: 26500 });
  assert.equal(WalletTx.rows[0].amount, 2);
  assert.equal(WalletTx.rows[0].meta.vndPerUsd, 25000);
});

test('QR credits the amount actually transferred', async () => {
  const WalletTx = fakeWalletTx([pendingRow({ meta: { channel: 'gpay_qr', amountVnd: 100000 } })]);
  const event = resolveOrderEvent({ qr_type: 'DYNAMIC', bill_id: 'AIMt1', amount: 53000, gpay_trans_id: 'Q1' });
  await settleOrderEvent(event, { WalletTx, vndPerUsd: 26500 });
  assert.equal(WalletTx.rows[0].status, 'completed');
  assert.equal(WalletTx.rows[0].amount, 2);
  assert.equal(WalletTx.rows[0].meta.paidVnd, 53000);
});

test('gateway and QR webhook signatures verify with GPay key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = require('../src/config/env');
  const prev = config.gpayPublicKey;
  config.gpayPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
  const sign = (input) => crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64');
  try {
    const portal = { gpay_bill_id: 'B', gpay_trans_id: 'G', merchant_order_id: 'AIMt1', status: 'ORDER_SUCCESS', embed_data: 'AIMt1', user_payment_method: 'BANK_ATM' };
    assert.equal(detectWebhookKind(portal), 'portal');
    assert.equal(verifyWebhookSignature({ ...portal, signature: sign(buildPortalWebhookInput(portal)) }), true);
    assert.equal(verifyWebhookSignature({ ...portal, status: 'ORDER_FAILED', signature: sign(buildPortalWebhookInput(portal)) }), false);

    const qr = { gpay_trans_id: 'Q', bank_transaction_id: 'BT', amount: 100000, merchant_code: 'M', source_of_fund: 'VIETQR', qr_type: 'DYNAMIC', bill_id: 'AIMt1' };
    assert.equal(verifyWebhookSignature({ ...qr, signature: sign(buildQrWebhookInputs(qr)[2]) }), true);
    assert.equal(verifyWebhookSignature({ ...qr, signature: sign(buildQrWebhookInputs(qr)[0]) }), true);
  } finally {
    config.gpayPublicKey = prev;
  }
});
