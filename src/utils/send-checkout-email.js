const { sendResendEmail, isEmailReady } = require('./mailer');
const { buildCheckoutEmail } = require('./checkout-email');
const config = require('../config/env');

function sendCheckoutSuccessEmail({ buyer, order, product, license }) {
  const to = buyer?.email;
  if (!to) return Promise.resolve({ skipped: true, reason: 'NO_BUYER_EMAIL' });
  if (!isEmailReady()) {
    if (!config.skipEmail) {
      console.warn('[mail] checkout email skipped (set RESEND_API_KEY + EMAIL_FROM)');
    }
    return Promise.resolve({ skipped: true, reason: 'NOT_CONFIGURED' });
  }

  const payload = buildCheckoutEmail({
    buyerName: buyer.name || buyer.email,
    productName: product?.name || order?.productName,
    orderId: String(order?._id || order?.id || ''),
    amount: order?.amount ?? order?.grossAmount,
    currency: order?.currency || 'USD',
    quantity: order?.quantity || 1,
    license,
    licensesUrl: `${config.frontendUrl.replace(/\/+$/, '')}/dashboard/licenses`,
  });

  return sendResendEmail({
    to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    tags: [
      { name: 'category', value: 'checkout' },
      { name: 'has_license', value: payload.hasLicense ? 'yes' : 'no' },
    ],
  }).catch((err) => {
    console.error('[mail] checkout email failed:', err.message);
    return { ok: false, error: err.message };
  });
}

module.exports = { sendCheckoutSuccessEmail };
