const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { settleSale } = require('../../src/finance/settlement-engine');
const { calculateSellerTax, publicTaxPolicy, sellerTaxRateFor } = require('../../src/finance/seller-tax-policy');
const { taxConfig } = require('../../src/config/tax');
const { taxCategoryFromProduct } = require('../../src/finance/tax-category');
const { validateSellerTaxInfo, isValidTaxCode, sellerApprovalGate } = require('../../src/utils/seller-compliance');
const { isPitCommitmentApproved, parsePitCommitmentSubmission, vnYear } = require('../../src/utils/pit-commitment');
const { quarterRange, buildSellerRows, buildAffiliateRows, withdrawalsToAffiliatePayments, renderQuarterlyReport, renderPitCertificates, totals } = require('../../src/finance/tax-report');
const { buildXlsx, buildCsv, crc32 } = require('../../src/utils/xlsx-writer');

const RULES = [{ rate: 0.2, status: 'ACTIVE' }];
const sale = (sellerType, extra = {}) =>
  settleSale({
    unitPrice: 1_000_000,
    ownershipType: 'THIRD_PARTY_SELLER',
    commissionRules: RULES,
    sellerTaxProfile: { sellerType },
    currency: 'VND',
    digits: 0,
    ...extra,
  });

describe('seller tax by type and product kind', () => {
  test('individual, digital: 5% GTGT + 2% TNCN = 70,000 on 1,000,000, snapshotted', () => {
    const s = sale('INDIVIDUAL', { product: { category: 'api-endpoint' } });
    assert.equal(s.taxAmount, 70_000);
    assert.deepEqual(s.taxBreakdown.map((t) => [t.type, t.rate, t.amount]), [['VAT', 0.05, 50_000], ['PIT', 0.02, 20_000]]);
    assert.equal(s.sellerType, 'INDIVIDUAL');
    assert.equal(s.taxPolicy.rate, 0.07);
    assert.equal(s.taxPolicy.withheldByPlatform, true);
    assert.equal(s.taxPolicy.productKind, 'DIGITAL');
    assert.match(s.taxPolicy.legalBasis, /252\/2026/);
  });
  test('individual, physical goods: 1% + 0.5% = 1.5%', () => {
    assert.equal(taxCategoryFromProduct({ productKind: 'physical' }), 'PHYSICAL_GOODS');
    const s = sale('INDIVIDUAL', { product: { productKind: 'physical' } });
    assert.equal(s.taxAmount, 15_000);
    assert.equal(s.taxPolicy.vatAmount, 10_000);
    assert.equal(s.taxPolicy.pitAmount, 5_000);
  });
  test('household business and company: 0%; company gets a VAT invoice for the fee', () => {
    const hkd = sale('HOUSEHOLD_BUSINESS');
    assert.equal(hkd.taxAmount, 0);
    assert.equal(hkd.taxPolicy.rule, 'HKD_SELF_DECLARES_NO_WITHHOLDING');
    assert.equal(hkd.platformFeeInvoice.required, false);
    const co = sale('enterprise');
    assert.equal(co.taxAmount, 0);
    assert.equal(co.sellerNetAmount, 800_000);
    assert.equal(co.platformFeeInvoice.required, true);
    assert.equal(co.platformFeeInvoice.vatRate, 0.1);
    assert.equal(co.platformFeeInvoice.feeAmount, 200_000);
  });
  test('tax is computed on the price after discount', () => {
    const s = sale('INDIVIDUAL', { unitPrice: 800_000 });
    assert.equal(s.taxableAmount, 800_000);
    assert.equal(s.taxAmount, 56_000);
  });
  test('annual threshold: no withholding while YTD revenue + order <= 100M; withheld above; unknown = withhold', () => {
    assert.equal(taxConfig({}).individual.annualThresholdVnd, 100_000_000);
    assert.equal(sale('INDIVIDUAL', { sellerAnnualRevenueVnd: 50_000_000 }).taxAmount, 0);
    assert.equal(sale('INDIVIDUAL', { sellerAnnualRevenueVnd: 99_000_000 }).taxAmount, 0);
    assert.equal(sale('INDIVIDUAL', { sellerAnnualRevenueVnd: 99_000_001 }).taxAmount, 70_000);
    assert.equal(sale('INDIVIDUAL').taxAmount, 70_000);
    const off = calculateSellerTax({ sellerType: 'INDIVIDUAL', grossAmount: 1_000_000, currency: 'VND', sellerAnnualRevenueVnd: 0, config: taxConfig({ TAX_INDIVIDUAL_ANNUAL_THRESHOLD_VND: '0' }) });
    assert.equal(off.totalTaxAmount, 70_000);
  });
  test('rates are env-configurable; public policy exposes them', () => {
    const cfg = taxConfig({ TAX_INDIVIDUAL_DIGITAL_PIT_RATE: '0.01' });
    assert.equal(calculateSellerTax({ sellerType: 'INDIVIDUAL', grossAmount: 1_000_000, currency: 'VND', config: cfg }).totalTaxAmount, 60_000);
    const p = publicTaxPolicy(taxConfig({}));
    assert.equal(p.individual.digital.total, 0.07);
    assert.equal(p.individual.goods.total, 0.015);
    assert.equal(p.householdBusiness.rate, 0);
    assert.equal(p.company.platformIssuesVatInvoiceOnFee, true);
    assert.equal(sellerTaxRateFor('COMPANY').total, 0);
  });
  test('platform-direct sales carry no seller tax', () => {
    const s = sale('INDIVIDUAL', { ownershipType: 'PLATFORM_DIRECT' });
    assert.equal(s.taxAmount, 0);
  });
});

describe('seller type + MST mandatory at registration', () => {
  test('missing type / bad MST / missing ĐKKD are rejected', () => {
    assert.equal(validateSellerTaxInfo({ taxCode: '0312345678' }, {}).code, 'SELLER_TYPE_REQUIRED');
    assert.equal(validateSellerTaxInfo({ sellerType: 'PLATFORM', taxCode: '0312345678' }, {}).code, 'SELLER_TYPE_INVALID');
    assert.equal(validateSellerTaxInfo({ sellerType: 'INDIVIDUAL' }, {}).code, 'TAX_CODE_REQUIRED');
    assert.equal(validateSellerTaxInfo({ sellerType: 'COMPANY', taxCode: '012345678901' }, {}).code, 'TAX_CODE_REQUIRED');
    assert.equal(validateSellerTaxInfo({ sellerType: 'HOUSEHOLD_BUSINESS', taxCode: '0312345678' }, {}).code, 'BUSINESS_REGISTRATION_REQUIRED');
  });
  test('valid submissions', () => {
    assert.deepEqual(validateSellerTaxInfo({ sellerType: 'individual', taxCode: '012345678901' }, {}), { ok: true, sellerType: 'INDIVIDUAL' });
    assert.equal(validateSellerTaxInfo({ sellerType: 'COMPANY', taxCode: '0312345678-001', businessRegistrationNumber: '0312345678' }, {}).sellerType, 'COMPANY');
    assert.equal(validateSellerTaxInfo({}, { sellerType: 'household_business', sellerTypeDeclaredAt: new Date(), taxCode: '0312345678', businessRegistrationNumber: 'HKD-1' }).ok, true);
    assert.equal(isValidTaxCode('03 1234 5678'), true);
  });
  test('approval gate needs the MST', () => {
    assert.equal(sellerApprovalGate({ sellerType: 'INDIVIDUAL', taxCode: '' }, { status: 'verified' }).code, 'SELLER_TAX_INFO_REQUIRED');
  });
});

describe('Mẫu 08/CK-TNCN commitment', () => {
  const at = new Date('2026-10-13T05:00:00Z');
  test('only an approved commitment for the payment year exempts', () => {
    assert.equal(vnYear(new Date('2026-12-31T18:00:00Z')), 2027);
    assert.equal(isPitCommitmentApproved({ pitCommitment: { status: 'approved', year: 2026 } }, at), true);
    assert.equal(isPitCommitmentApproved({ pitCommitment: { status: 'approved', year: 2025 } }, at), false);
    assert.equal(isPitCommitmentApproved({ pitCommitment: { status: 'pending', year: 2026 } }, at), false);
    assert.equal(isPitCommitmentApproved(null, at), false);
  });
  test('submission needs the document, a valid year and a tax code', () => {
    assert.equal(parsePitCommitmentSubmission({}, { pitCommitment: {} }, at).code, 'NO_DOCUMENT');
    const u = { pitCommitment: { objectName: 'kyc/u/pit.pdf', status: 'draft' }, kyc: { idNumber: '012345678901' } };
    assert.equal(parsePitCommitmentSubmission({ year: 2024 }, u, at).code, 'INVALID_YEAR');
    assert.deepEqual(parsePitCommitmentSubmission({ year: 2026 }, u, at), { ok: true, data: { year: 2026, personalTaxCode: '012345678901' } });
    assert.equal(parsePitCommitmentSubmission({}, { pitCommitment: { objectName: 'x', status: 'pending' } }, at).code, 'PIT_COMMITMENT_PENDING');
  });
});

describe('quarterly report + year-end PIT certificate exports', () => {
  test('quarter ranges in Asia/Bangkok and filing months 4/7/10/1', () => {
    const q3 = quarterRange(2026, 3);
    assert.equal(q3.from.toISOString(), '2026-06-30T17:00:00.000Z');
    assert.equal(q3.to.toISOString(), '2026-09-30T17:00:00.000Z');
    assert.equal(q3.filingMonth, 10);
    const q4 = quarterRange(2026, 4);
    assert.equal(q4.filingMonth, 1);
    assert.equal(q4.filingYear, 2027);
    assert.throws(() => quarterRange(2026, 5));
  });
  test('seller rows include individuals and HKD only; affiliate rows sum income and PIT', () => {
    const orders = [
      { seller: 'a', sellerType: 'INDIVIDUAL', currency: 'VND', grossAmount: 1_000_000, taxAmount: 70_000, taxPolicy: { vatAmount: 50_000, pitAmount: 20_000 } },
      { seller: 'a', sellerType: 'INDIVIDUAL', currency: 'VND', grossAmount: 500_000, refundAmount: 100_000, taxAmount: 35_000, taxPolicy: { vatAmount: 25_000, pitAmount: 10_000 } },
      { seller: 'h', sellerType: 'HOUSEHOLD_BUSINESS', currency: 'USD', grossAmount: 10, taxAmount: 0 },
      { seller: 'c', sellerType: 'COMPANY', currency: 'VND', grossAmount: 9_000_000, taxAmount: 0 },
    ];
    const rows = buildSellerRows(orders, new Map([['a', { legalName: 'Nguyễn Văn A', taxCode: '012345678901' }]]), 26_500);
    assert.equal(rows.length, 2);
    const a = rows.find((r) => r.sellerId === 'a');
    assert.equal(a.revenueVnd, 1_500_000);
    assert.equal(a.netRevenueVnd, 1_400_000);
    assert.equal(a.vatWithheldVnd, 75_000);
    assert.equal(a.pitWithheldVnd, 30_000);
    assert.equal(rows.find((r) => r.sellerId === 'h').revenueVnd, 265_000);
    const aff = buildAffiliateRows([
      { affiliate: 'x', currency: 'VND', amount: 2_500_000, amountVnd: 2_500_000, netAmount: 2_250_000, pitAmount: 250_000, createdAt: '2026-08-01T00:00:00Z' },
      { affiliate: 'x', currency: 'VND', amount: 250_000, amountVnd: 250_000, netAmount: 250_000, pitAmount: 0, createdAt: '2026-09-01T00:00:00Z' },
      { affiliate: 'x', currency: 'VND', amount: 250_000, netAmount: 250_000, reversedAmount: 250_000, pitAmount: 0, createdAt: '2026-09-02T00:00:00Z' },
    ]);
    assert.equal(aff[0].payments, 2);
    assert.equal(aff[0].incomeVnd, 2_750_000);
    assert.equal(aff[0].pitWithheldVnd, 250_000);
    const report = { year: 2026, quarter: 3, from: 'f', to: 't', filingMonth: 10, filingYear: 2026, sellers: rows, affiliates: aff, totals: totals(rows, aff) };
    const csv = renderQuarterlyReport(report, 'csv');
    assert.match(csv.filename, /2026-Q3\.csv$/);
    assert.match(csv.body, /Nguyễn Văn A/);
    assert.ok(csv.body.startsWith('\ufeff'));
    const xlsx = renderQuarterlyReport(report, 'xlsx');
    assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
    const cert = renderPitCertificates([{ kind: 'AFFILIATE', personId: 'x', year: 2026, totalIncomeVnd: 1, totalPitWithheldVnd: 0 }], 2026, 'csv');
    assert.match(cert.body, /AFFILIATE/);
  });

  test('affiliate PIT rows come from affiliate withdrawals (one withdrawal = one payment)', () => {
    const pays = withdrawalsToAffiliatePayments([
      { user: 'x', type: 'withdraw', status: 'pending', currency: 'USD', amount: 100, meta: { persona: 'affiliate', amountVnd: 2_500_000, pitAmount: 10, pitAmountVnd: 250_000 }, createdAt: '2026-08-01T00:00:00Z' },
      { user: 'x', type: 'withdraw', status: 'completed', currency: 'USD', amount: 80, meta: { persona: 'affiliate', amountVnd: 2_000_000, pitAmount: 0, pitAmountVnd: 0, pitCommitmentApplied: true }, createdAt: '2026-09-01T00:00:00Z' },
      { user: 'x', type: 'withdraw', status: 'failed', currency: 'USD', amount: 80, meta: { persona: 'affiliate', amountVnd: 2_000_000 }, createdAt: '2026-09-02T00:00:00Z' },
      { user: 'x', type: 'withdraw', status: 'completed', currency: 'USD', amount: 50, meta: { persona: 'buyer' }, createdAt: '2026-09-03T00:00:00Z' },
    ]);
    assert.equal(pays.length, 2);
    const rows = buildAffiliateRows(pays);
    assert.equal(rows[0].payments, 2);
    assert.equal(rows[0].incomeVnd, 4_500_000);
    assert.equal(rows[0].pitWithheldVnd, 250_000);
    assert.equal(rows[0].exemptByCommitment, 1);
  });
  test('xlsx writer: valid zip entries with correct CRC', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    const buf = buildXlsx([{ name: 'S', rows: [['a', 1], ['<&>', 2.5]] }]);
    const name = '[Content_Types].xml';
    assert.ok(buf.includes(Buffer.from(name)));
    assert.ok(buf.includes(Buffer.from('&lt;&amp;&gt;')));
    assert.equal(typeof zlib.crc32 === 'function' ? zlib.crc32('123456789') : 0xcbf43926, 0xcbf43926);
    assert.equal(buildCsv([['a,b', 'c"d']]), '\ufeff"a,b","c""d"\r\n');
  });
});
