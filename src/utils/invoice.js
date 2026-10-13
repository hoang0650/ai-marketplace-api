/**
 * Order VAT invoice choice (NĐ 123/2020/NĐ-CP as amended by NĐ 70/2025/NĐ-CP).
 */
const NO_INVOICE_BUYER_NAME = 'Người mua không lấy hóa đơn';
const BUYER_TYPES = ['organization', 'individual'];
const VN_OFFSET_MS = 7 * 3600 * 1000;

/** End of the purchase day in Vietnam time (23:59:59.999 UTC+7). */
function endOfVnDay(at = new Date()) {
  const vn = new Date(new Date(at).getTime() + VN_OFFSET_MS);
  const end = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), 23, 59, 59, 999);
  return new Date(end - VN_OFFSET_MS);
}

/** MST: 10 digits, or 10 digits + "-" + 3 digits (branch / dependent unit, 13 digits). */
function normalizeTaxCode(raw) {
  return String(raw || '').replace(/[\s.]/g, '');
}
function isValidTaxCode(raw) {
  return /^\d{10}(-\d{3})?$/.test(normalizeTaxCode(raw));
}
/** Individuals: 10-digit personal tax code or 12-digit CCCD. */
function isValidPersonalId(raw) {
  return /^(\d{10}|\d{12})$/.test(normalizeTaxCode(raw));
}
function isValidEmail(raw) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(raw || '').trim());
}
function clean(v, max) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const err = (code, message) => ({ ok: false, code, message });

/**
 * Parse the buyer's invoice choice.
 * @returns {{ok:true, data:object} | {ok:false, code, message}}
 */
function parseInvoiceChoice(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!b.wantsInvoice) {
    return {
      ok: true,
      data: {
        wantsInvoice: false,
        buyerType: 'none',
        buyerName: NO_INVOICE_BUYER_NAME,
        taxCode: '',
        personalId: '',
        address: '',
        email: '',
        budgetUnitCode: '',
      },
    };
  }
  const buyerType = String(b.buyerType || '');
  if (!BUYER_TYPES.includes(buyerType)) return err('INVALID_BUYER_TYPE', 'buyerType must be organization or individual');
  const buyerName = clean(b.buyerName, 300);
  const address = clean(b.address, 500);
  const email = clean(b.email, 200).toLowerCase();
  if (buyerName.length < 2) {
    return err('INVOICE_NAME_REQUIRED', buyerType === 'organization' ? 'Company name is required' : 'Full name is required');
  }
  if (address.length < 5) return err('INVOICE_ADDRESS_REQUIRED', 'Address is required');
  if (!isValidEmail(email)) return err('INVALID_EMAIL', 'A valid email to receive the invoice is required');
  if (buyerType === 'organization') {
    if (!isValidTaxCode(b.taxCode)) {
      return err('INVALID_TAX_CODE', 'Tax code (MST) must be 10 digits or 10 digits + "-" + 3 digits');
    }
    const budgetUnitCode = clean(b.budgetUnitCode, 20);
    if (budgetUnitCode && !/^[A-Za-z0-9-]{3,20}$/.test(budgetUnitCode)) {
      return err('INVALID_BUDGET_UNIT_CODE', 'Buyer unit / budget unit code must be 3–20 letters, digits or "-"');
    }
    return {
      ok: true,
      data: { wantsInvoice: true, buyerType, buyerName, taxCode: normalizeTaxCode(b.taxCode), personalId: '', address, email, budgetUnitCode },
    };
  }
  const personalId = normalizeTaxCode(b.personalId);
  if (personalId && !isValidPersonalId(personalId)) {
    return err('INVALID_PERSONAL_ID', 'Personal tax code (10 digits) or CCCD (12 digits)');
  }
  return {
    ok: true,
    data: { wantsInvoice: true, buyerType, buyerName, taxCode: '', personalId, address, email, budgetUnitCode: '' },
  };
}

/** Prefill from the saved invoice profile, else eKYC/profile. */
function invoicePrefill(user) {
  const saved = user?.invoiceProfile;
  if (saved && saved.buyerType && BUYER_TYPES.includes(saved.buyerType)) {
    return {
      buyerType: saved.buyerType,
      buyerName: saved.buyerName || '',
      taxCode: saved.taxCode || '',
      personalId: saved.personalId || '',
      address: saved.address || '',
      email: saved.email || user?.email || '',
      budgetUnitCode: saved.budgetUnitCode || '',
      source: 'saved',
    };
  }
  const k = user?.kyc || {};
  const org = k.subjectType === 'organization';
  return {
    buyerType: org ? 'organization' : 'individual',
    buyerName: (org ? k.orgName : k.fullName) || user?.name || '',
    taxCode: org ? k.orgTaxCode || '' : '',
    personalId: org ? '' : k.personalTaxCode || '',
    address: (org ? k.orgAddress : '') || '',
    email: user?.email || '',
    budgetUnitCode: '',
    source: k.status === 'verified' ? 'kyc' : 'profile',
  };
}

function isEditable(inv, now = new Date()) {
  if (!inv || inv.status !== 'pending') return false;
  return !inv.editableUntil || new Date(now) <= new Date(inv.editableUntil);
}

function mapInvoice(inv, { admin = false, now = new Date() } = {}) {
  if (!inv) return null;
  const out = {
    id: String(inv._id),
    orderId: String(inv.order?._id || inv.order),
    productName: inv.productName || '',
    amount: inv.amount || 0,
    currency: inv.currency || 'USD',
    orderedAt: inv.orderedAt ? new Date(inv.orderedAt).toISOString() : null,
    wantsInvoice: !!inv.wantsInvoice,
    buyerType: inv.buyerType || 'none',
    buyerName: inv.buyerName || NO_INVOICE_BUYER_NAME,
    taxCode: inv.taxCode || '',
    personalId: inv.personalId || '',
    address: inv.address || '',
    email: inv.email || '',
    budgetUnitCode: inv.budgetUnitCode || '',
    status: inv.status || 'pending',
    invoiceNumber: inv.invoiceNumber || '',
    invoiceSeries: inv.invoiceSeries || '',
    lookupCode: inv.lookupCode || '',
    hasPdf: Boolean(inv.pdfObjectName),
    issuedAt: inv.issuedAt ? new Date(inv.issuedAt).toISOString() : null,
    editableUntil: inv.editableUntil ? new Date(inv.editableUntil).toISOString() : null,
    editable: isEditable(inv, now),
    provider: inv.provider || 'manual',
  };
  if (admin) {
    const b = inv.buyer && typeof inv.buyer === 'object' && inv.buyer.email ? inv.buyer : null;
    out.buyer = b ? { id: String(b._id), name: b.name || '', email: b.email || '' } : { id: String(inv.buyer || '') };
    out.providerRef = inv.providerRef || '';
    out.pdfObjectName = inv.pdfObjectName || '';
  }
  return out;
}

module.exports = {
  NO_INVOICE_BUYER_NAME,
  BUYER_TYPES,
  endOfVnDay,
  isValidTaxCode,
  isValidPersonalId,
  parseInvoiceChoice,
  invoicePrefill,
  isEditable,
  mapInvoice,
};
