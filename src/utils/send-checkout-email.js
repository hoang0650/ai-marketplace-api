const { sendResendEmail, isEmailReady } = require('./mailer');
const { buildCheckoutEmail } = require('./checkout-email');
const config = require('../config/env');
const User = require('../models/User');

async function resolveBuyer(buyer) {
  const email = String(buyer?.email || '').trim();
  const name = String(buyer?.name || '').trim();
  if (email.includes('@')) return { email, name: name || email };
  const id = buyer?._id || buyer?.id;
  if (!id) return { email: '', name };
  const doc = await User.findById(id).select('email name').lean();
  return {
    email: String(doc?.email || '').trim(),
    name: name || String(doc?.name || '').trim(),
  };
}

async function sendCheckoutSuccessEmail({ buyer, order, product, license }) {
  const contact = await resolveBuyer(buyer);
  const to = contact.email;
  if (!to) return { skipped: true, reason: 'NO_BUYER_EMAIL' };
  if (!isEmailReady()) {
    if (!config.skipEmail) {
      console.warn('[mail] checkout email skipped (set RESEND_API_KEY + EMAIL_FROM)');
    }
    return { skipped: true, reason: 'NOT_CONFIGURED', to };
  }

  const payload = buildCheckoutEmail({
    buyerName: contact.name || to,
    productName: product?.name || order?.productName,
    orderId: String(order?._id || order?.id || ''),
    amount: order?.amount ?? order?.grossAmount,
    currency: order?.currency || 'USD',
    quantity: order?.quantity || 1,
    license,
    licensesUrl: `${config.frontendUrl.replace(/\/+$/, '')}/dashboard/licenses`,
  });

  const result = await sendResendEmail({
    to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    tags: [
      { name: 'category', value: 'checkout' },
      { name: 'has_license', value: payload.hasLicense ? 'yes' : 'no' },
    ],
  });
  return { ...result, to };
}

module.exports = { sendCheckoutSuccessEmail };
