/**
 * E-invoice provider hook. Today invoices are issued manually by admin (status → issued, number/PDF attached).
 * To integrate a provider (VNPT, Viettel S-Invoice, MISA meInvoice, …) later: add an adapter here that
 * implements issue(invoice) → { invoiceNumber, invoiceSeries, lookupCode, providerRef, pdfBuffer? } and select it
 * with EINVOICE_PROVIDER. Nothing calls a real provider in this codebase yet.
 */
const adapters = {
  manual: {
    name: 'manual',
    automatic: false,
    async issue() {
      return null; // admin issues in the provider portal and records the number/PDF
    },
  },
};

function getEinvoiceProvider() {
  const key = String(process.env.EINVOICE_PROVIDER || 'manual').trim().toLowerCase();
  return adapters[key] || adapters.manual;
}

module.exports = { getEinvoiceProvider, adapters };
