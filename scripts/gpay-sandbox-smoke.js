/* Smoke test against GPay sandbox: token, init-bill, qr-payment. No DB writes. */
require('dotenv').config();
const mongoose = require('mongoose');
const gpay = require('../src/utils/gpay-client');
const { orderRequestId } = require('../src/finance/gpayOrders');

async function step(name, fn) {
  try {
    const out = await fn();
    console.log(`OK   ${name}`, out === undefined ? '' : JSON.stringify(out));
    return out;
  } catch (err) {
    console.log(`FAIL ${name}: [${err.code || ''}] ${err.message}`, err.detail ? JSON.stringify(err.detail.meta || err.detail) : '');
    return null;
  }
}

(async () => {
  if (!gpay.gpaySandbox()) {
    console.log('GPAY_SANDBOX is not true; refusing to run against live GPay.');
    process.exit(1);
  }
  console.log('VA base    ', gpay.vaBase());
  console.log('Portal base', gpay.portalBase());

  await step('VA/QR token', async () => ((await gpay.getAccessToken()) ? 'token received' : 'no token'));

  const billReq = orderRequestId(new mongoose.Types.ObjectId());
  await step('portal init-bill', async () => {
    const b = await gpay.initBill({
      requestId: billReq,
      amountVnd: 10000,
      customerId: 'smoketest',
      customerName: 'Smoke Test',
      title: 'AI Markets wallet top-up',
      description: `Nap vi AI Markets ${billReq}`,
      callbackUrl: `http://localhost:4100/v1/gpay/return?order=${billReq}&app=0`,
      embedData: billReq,
    });
    return { bill_id: b.bill_id, has_url: Boolean(b.bill_url), bill_url_host: b.bill_url ? new URL(b.bill_url).host : null, expired_time: b.expired_time };
  });

  const qrReq = orderRequestId(new mongoose.Types.ObjectId());
  await step('qr-payment create', async () => {
    const q = await gpay.createQrPayment({ billId: qrReq, amountVnd: 10000, accountName: 'AI MARKETS', description: qrReq });
    return { has_qr: Boolean(q.qr_code), has_img: Boolean(q.qr_code_image), provider: q.provider, account_name: q.account_name };
  });
})();
