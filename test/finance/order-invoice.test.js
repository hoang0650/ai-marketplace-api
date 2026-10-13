const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NO_INVOICE_BUYER_NAME,
  endOfVnDay,
  isValidTaxCode,
  isValidPersonalId,
  parseInvoiceChoice,
  invoicePrefill,
  isEditable,
  mapInvoice,
} = require('../../src/utils/invoice');
const { getEinvoiceProvider } = require('../../src/finance/einvoice-provider');

test('default / declined choice records "Người mua không lấy hóa đơn" with no buyer details', () => {
  const r = parseInvoiceChoice({ wantsInvoice: false, buyerName: 'X', taxCode: '0312345678' });
  assert.equal(r.ok, true);
  assert.equal(r.data.buyerName, NO_INVOICE_BUYER_NAME);
  assert.equal(r.data.buyerType, 'none');
  assert.equal(r.data.taxCode, '');
  assert.equal(parseInvoiceChoice(undefined).data.buyerName, 'Người mua không lấy hóa đơn');
});

test('MST: 10 digits or 10-3 (13 digits with dash)', () => {
  assert.equal(isValidTaxCode('0312345678'), true);
  assert.equal(isValidTaxCode('0312345678-001'), true);
  assert.equal(isValidTaxCode('031 234 5678'), true);
  assert.equal(isValidTaxCode('0312345678001'), false);
  assert.equal(isValidTaxCode('031234567'), false);
  assert.equal(isValidTaxCode('0312345678-01'), false);
  assert.equal(isValidPersonalId('079123456789'), true);
  assert.equal(isValidPersonalId('8012345678'), true);
  assert.equal(isValidPersonalId('12345'), false);
});

test('organization invoice validation', () => {
  const org = { wantsInvoice: true, buyerType: 'organization', buyerName: 'Công ty TNHH ABC', taxCode: '0312345678-001', address: '12 Nguyễn Huệ, Q1, TP.HCM', email: 'KeToan@ABC.vn' };
  const ok = parseInvoiceChoice(org);
  assert.equal(ok.ok, true);
  assert.equal(ok.data.email, 'ketoan@abc.vn');
  assert.equal(ok.data.taxCode, '0312345678-001');
  assert.equal(parseInvoiceChoice({ ...org, taxCode: '123' }).code, 'INVALID_TAX_CODE');
  assert.equal(parseInvoiceChoice({ ...org, email: 'nope' }).code, 'INVALID_EMAIL');
  assert.equal(parseInvoiceChoice({ ...org, address: '' }).code, 'INVOICE_ADDRESS_REQUIRED');
  assert.equal(parseInvoiceChoice({ ...org, buyerName: '' }).code, 'INVOICE_NAME_REQUIRED');
  assert.equal(parseInvoiceChoice({ ...org, budgetUnitCode: '1234567' }).data.budgetUnitCode, '1234567');
  assert.equal(parseInvoiceChoice({ ...org, budgetUnitCode: '!!' }).code, 'INVALID_BUDGET_UNIT_CODE');
  assert.equal(parseInvoiceChoice({ ...org, buyerType: 'x' }).code, 'INVALID_BUYER_TYPE');
});

test('individual invoice: personal tax code / CCCD optional', () => {
  const ind = { wantsInvoice: true, buyerType: 'individual', buyerName: 'Nguyễn Văn A', address: '1 Lê Lợi, Huế', email: 'a@x.vn' };
  assert.equal(parseInvoiceChoice(ind).ok, true);
  assert.equal(parseInvoiceChoice({ ...ind, personalId: '079123456789' }).data.personalId, '079123456789');
  assert.equal(parseInvoiceChoice({ ...ind, personalId: '123' }).code, 'INVALID_PERSONAL_ID');
  assert.equal(parseInvoiceChoice({ ...ind, taxCode: '0312345678' }).data.taxCode, '');
});

test('edit window: until end of the purchase day (VN time), locked once issued', () => {
  // 2026-10-13 20:00 UTC+7 = 13:00Z → ends 2026-10-13 23:59:59.999 UTC+7 = 16:59:59.999Z
  assert.equal(endOfVnDay(new Date('2026-10-13T13:00:00Z')).toISOString(), '2026-10-13T16:59:59.999Z');
  // 2026-10-14 01:00 UTC+7 = 2026-10-13T18:00Z → next VN day
  assert.equal(endOfVnDay(new Date('2026-10-13T18:00:00Z')).toISOString(), '2026-10-14T16:59:59.999Z');
  const inv = { status: 'pending', editableUntil: new Date('2026-10-13T16:59:59.999Z') };
  assert.equal(isEditable(inv, new Date('2026-10-13T16:00:00Z')), true);
  assert.equal(isEditable(inv, new Date('2026-10-13T17:00:00Z')), false);
  assert.equal(isEditable({ ...inv, status: 'issued' }, new Date('2026-10-13T16:00:00Z')), false);
});

test('prefill: saved profile, else eKYC', () => {
  const kycUser = { name: 'a', email: 'a@x.vn', kyc: { status: 'verified', subjectType: 'organization', orgName: 'Cty ABC', orgTaxCode: '0312345678', orgAddress: 'HCM' } };
  const p = invoicePrefill(kycUser);
  assert.equal(p.buyerType, 'organization');
  assert.equal(p.taxCode, '0312345678');
  assert.equal(p.source, 'kyc');
  const saved = invoicePrefill({ ...kycUser, invoiceProfile: { buyerType: 'individual', buyerName: 'B', address: 'HN', email: 'b@x.vn' } });
  assert.equal(saved.source, 'saved');
  assert.equal(saved.buyerName, 'B');
});

test('mapInvoice hides admin-only fields; provider hook defaults to manual', () => {
  const inv = { _id: 'i1', order: 'o1', buyer: 'u1', status: 'pending', pdfObjectName: 'aimarkets/invoices/o1/x.pdf', providerRef: 'r' };
  const own = mapInvoice(inv);
  assert.equal(own.buyerName, NO_INVOICE_BUYER_NAME);
  assert.equal(own.hasPdf, true);
  assert.equal('pdfObjectName' in own, false);
  assert.equal(mapInvoice(inv, { admin: true }).pdfObjectName, 'aimarkets/invoices/o1/x.pdf');
  assert.equal(getEinvoiceProvider().name, 'manual');
});
