/**
 * Payment providers collect customer funds only.
 * They must not decide commission, tax, or seller payable.
 *
 * @typedef {object} PaymentProvider
 * @property {(input: object) => Promise<object>} createPayment
 * @property {(input: object) => Promise<object>} verifyPayment
 * @property {(input: object) => Promise<object>} refundPayment
 * @property {(input: object) => Promise<object>} handleWebhook
 */

class InternalLedgerProvider {
  async createPayment() {
    return { provider: 'internal_ledger', status: 'created' };
  }
  async verifyPayment() {
    return { provider: 'internal_ledger', status: 'paid' };
  }
  async refundPayment() {
    return { provider: 'internal_ledger', status: 'refunded' };
  }
  async handleWebhook(payload) {
    return { provider: 'internal_ledger', accepted: true, payload };
  }
}

function getPaymentProvider(name = 'internal_ledger') {
  return new InternalLedgerProvider();
}

module.exports = { InternalLedgerProvider, getPaymentProvider };
