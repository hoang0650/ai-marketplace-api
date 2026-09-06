const crypto = require('crypto');
const PaymentEvent = require('../models/PaymentEvent');

async function claimEvent({ eventId, provider, kind, orderId = null }) {
  const id = String(eventId || '').trim();
  if (!id) {
    const err = new Error('eventId required');
    err.status = 400;
    throw err;
  }
  try {
    await PaymentEvent.create({
      eventId: id,
      provider,
      kind,
      orderId,
      payloadHash: crypto.createHash('sha256').update(id).digest('hex'),
    });
    return { duplicate: false };
  } catch (err) {
    if (err?.code === 11000) return { duplicate: true };
    throw err;
  }
}

module.exports = { claimEvent };
