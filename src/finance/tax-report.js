/**
 * Tax reporting (tax policy 2026-10).
 *
 * - Quarterly report (admin): revenue of all individual sellers and household businesses, the
 *   VAT/PIT the platform withheld for individuals (NĐ 117/2025/NĐ-CP), and PIT withheld from
 *   affiliates - for submission on the tax authority portal in months 1, 4, 7 and 10.
 * - Year-end PIT withholding certificates (chứng từ khấu trừ thuế TNCN, Luật Thuế TNCN /
 *   Thông tư 40/2021/TT-BTC): per-person yearly income and PIT withheld.
 * Pure builders take plain rows so they can be unit-tested; loaders read MongoDB.
 */
const { roundMoney } = require('./constants');
const { normalizeSellerType } = require('./seller-types');
const { taxConfig } = require('../config/tax');
const { buildCsv, buildXlsx } = require('../utils/xlsx-writer');

const VN_OFFSET_MS = 7 * 3600 * 1000;
const REPORTED_SELLER_TYPES = new Set(['INDIVIDUAL', 'HOUSEHOLD_BUSINESS', 'FOREIGN_INDIVIDUAL']);

/** [from, to) of a quarter in Asia/Bangkok. */
function quarterRange(year, quarter) {
  const y = Number(year);
  const q = Number(quarter);
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || ![1, 2, 3, 4].includes(q)) {
    const err = new Error('year (YYYY) and quarter (1-4) are required');
    err.status = 400;
    throw err;
  }
  const from = new Date(Date.UTC(y, (q - 1) * 3, 1) - VN_OFFSET_MS);
  const to = new Date(Date.UTC(q === 4 ? y + 1 : y, q === 4 ? 0 : q * 3, 1) - VN_OFFSET_MS);
  return { from, to, year: y, quarter: q, filingMonth: [4, 7, 10, 1][q - 1], filingYear: q === 4 ? y + 1 : y };
}

function yearRange(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    const err = new Error('year (YYYY) is required');
    err.status = 400;
    throw err;
  }
  return { from: new Date(Date.UTC(y, 0, 1) - VN_OFFSET_MS), to: new Date(Date.UTC(y + 1, 0, 1) - VN_OFFSET_MS), year: y };
}

function toVnd(amount, currency, fx) {
  return roundMoney(String(currency || 'USD').toUpperCase() === 'VND' ? Number(amount) || 0 : (Number(amount) || 0) * fx, 0);
}

/**
 * Group orders by seller. `orders`: { seller, sellerType, currency, grossAmount|amount, refundAmount,
 * taxAmount, taxPolicy }. `sellers`: Map(sellerId -> { legalName, taxCode, idNumber, address, sellerType }).
 */
function buildSellerRows(orders, sellers = new Map(), fx = taxConfig().vndPerUsd) {
  const bySeller = new Map();
  for (const o of orders || []) {
    const id = String(o.seller?._id || o.seller);
    const info = sellers.get(id) || {};
    const sellerType = normalizeSellerType(o.sellerType || info.sellerType);
    if (!REPORTED_SELLER_TYPES.has(sellerType)) continue;
    const row = bySeller.get(id) || {
      sellerId: id,
      sellerType,
      legalName: info.legalName || '',
      taxCode: info.taxCode || '',
      idNumber: info.idNumber || '',
      address: info.address || '',
      orders: 0,
      revenueVnd: 0,
      refundVnd: 0,
      netRevenueVnd: 0,
      vatWithheldVnd: 0,
      pitWithheldVnd: 0,
      totalWithheldVnd: 0,
    };
    const gross = toVnd(o.grossAmount ?? o.amount, o.currency, fx);
    const refund = toVnd(o.refundAmount, o.currency, fx);
    const tax = toVnd(o.taxAmount, o.currency, fx);
    const vat = o.taxPolicy ? toVnd(o.taxPolicy.vatAmount, o.currency, fx) : 0;
    const pit = o.taxPolicy ? toVnd(o.taxPolicy.pitAmount, o.currency, fx) : 0;
    row.orders += 1;
    row.revenueVnd += gross;
    row.refundVnd += refund;
    row.netRevenueVnd += gross - refund;
    row.vatWithheldVnd += vat;
    row.pitWithheldVnd += pit;
    row.totalWithheldVnd += tax;
    bySeller.set(id, row);
  }
  return [...bySeller.values()].sort((a, b) => a.sellerType.localeCompare(b.sellerType) || b.revenueVnd - a.revenueVnd);
}

/** Group active affiliate commissions by affiliate (gross commission = taxable income). */
function buildAffiliateRows(commissions, people = new Map(), fx = taxConfig().vndPerUsd) {
  const byAff = new Map();
  for (const c of commissions || []) {
    const id = String(c.affiliate?._id || c.affiliate);
    const info = people.get(id) || {};
    const row = byAff.get(id) || {
      affiliateId: id,
      fullName: info.fullName || '',
      taxCode: info.taxCode || '',
      idNumber: info.idNumber || '',
      address: info.address || '',
      payments: 0,
      incomeVnd: 0,
      pitWithheldVnd: 0,
      exemptByCommitment: 0,
      firstMonth: null,
      lastMonth: null,
    };
    const share = c.amount > 0 ? Math.max(0, 1 - (Number(c.reversedAmount) || 0) / (Number(c.netAmount) || c.amount)) : 0;
    const income = c.amountVnd ? roundMoney(c.amountVnd * share, 0) : toVnd(c.amount * share, c.currency, fx);
    if (!(share > 0)) continue;
    const pit = toVnd((Number(c.pitAmount) || 0) * share, c.currency, fx);
    row.payments += 1;
    row.incomeVnd += income;
    row.pitWithheldVnd += pit;
    if (c.pitCommitmentApplied) row.exemptByCommitment += 1;
    const m = new Date(new Date(c.createdAt || Date.now()).getTime() + VN_OFFSET_MS).getUTCMonth() + 1;
    row.firstMonth = row.firstMonth ? Math.min(row.firstMonth, m) : m;
    row.lastMonth = row.lastMonth ? Math.max(row.lastMonth, m) : m;
    byAff.set(id, row);
  }
  return [...byAff.values()].sort((a, b) => b.incomeVnd - a.incomeVnd);
}

const SELLER_HEADER = [
  'Mã người bán',
  'Loại người bán',
  'Họ tên / Tên hộ kinh doanh',
  'MST',
  'Số CCCD',
  'Địa chỉ',
  'Số đơn',
  'Doanh thu (VND)',
  'Hoàn tiền (VND)',
  'Doanh thu thuần (VND)',
  'GTGT đã khấu trừ (VND)',
  'TNCN đã khấu trừ (VND)',
  'Tổng thuế đã khấu trừ (VND)',
];
const AFFILIATE_HEADER = [
  'Mã affiliate',
  'Họ tên',
  'MST cá nhân',
  'Số CCCD',
  'Địa chỉ',
  'Số lần chi trả',
  'Thu nhập chịu thuế (VND)',
  'Thuế TNCN đã khấu trừ (VND)',
  'Số lần miễn khấu trừ (Mẫu 08/CK-TNCN)',
];
const TYPE_LABEL = { INDIVIDUAL: 'Cá nhân kinh doanh', HOUSEHOLD_BUSINESS: 'Hộ kinh doanh', FOREIGN_INDIVIDUAL: 'Cá nhân nước ngoài' };

function sellerTable(rows) {
  return [
    SELLER_HEADER,
    ...rows.map((r) => [
      r.sellerId,
      TYPE_LABEL[r.sellerType] || r.sellerType,
      r.legalName,
      r.taxCode,
      r.idNumber,
      r.address,
      r.orders,
      r.revenueVnd,
      r.refundVnd,
      r.netRevenueVnd,
      r.vatWithheldVnd,
      r.pitWithheldVnd,
      r.totalWithheldVnd,
    ]),
  ];
}

function affiliateTable(rows) {
  return [
    AFFILIATE_HEADER,
    ...rows.map((r) => [r.affiliateId, r.fullName, r.taxCode, r.idNumber, r.address, r.payments, r.incomeVnd, r.pitWithheldVnd, r.exemptByCommitment]),
  ];
}

/** Render a report as csv | xlsx | json. CSV puts sections one after the other. */
function renderQuarterlyReport(report, format = 'xlsx') {
  const f = String(format || 'xlsx').toLowerCase();
  const tag = `${report.year}-Q${report.quarter}`;
  if (f === 'json') return { contentType: 'application/json', filename: `bao-cao-thue-${tag}.json`, body: JSON.stringify(report) };
  const meta = [
    ['Báo cáo thuế quý', tag],
    ['Kỳ', `${report.from} → ${report.to}`],
    ['Hạn nộp (tháng)', `${report.filingMonth}/${report.filingYear}`],
    ['Căn cứ', 'NĐ 117/2025/NĐ-CP; Luật Thuế TNCN; TT 40/2021/TT-BTC'],
  ];
  if (f === 'csv') {
    const rows = [...meta, [], ['NGƯỜI BÁN (cá nhân, hộ kinh doanh)'], ...sellerTable(report.sellers), [], ['AFFILIATE (thuế TNCN khấu trừ)'], ...affiliateTable(report.affiliates)];
    return { contentType: 'text/csv; charset=utf-8', filename: `bao-cao-thue-${tag}.csv`, body: buildCsv(rows) };
  }
  return {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `bao-cao-thue-${tag}.xlsx`,
    body: buildXlsx([
      { name: 'Tong hop', rows: [...meta, [], ['Tổng doanh thu người bán (VND)', report.totals.sellerRevenueVnd], ['Tổng thuế đã khấu trừ người bán (VND)', report.totals.sellerWithheldVnd], ['Tổng thu nhập affiliate (VND)', report.totals.affiliateIncomeVnd], ['Tổng TNCN affiliate đã khấu trừ (VND)', report.totals.affiliatePitVnd]] },
      { name: 'Nguoi ban', rows: sellerTable(report.sellers) },
      { name: 'Affiliate', rows: affiliateTable(report.affiliates) },
    ]),
  };
}

function totals(sellers, affiliates) {
  const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0);
  return {
    sellerCount: sellers.length,
    sellerRevenueVnd: sum(sellers, 'revenueVnd'),
    sellerNetRevenueVnd: sum(sellers, 'netRevenueVnd'),
    sellerWithheldVnd: sum(sellers, 'totalWithheldVnd'),
    affiliateCount: affiliates.length,
    affiliateIncomeVnd: sum(affiliates, 'incomeVnd'),
    affiliatePitVnd: sum(affiliates, 'pitWithheldVnd'),
  };
}

/* ---------------------------- DB loaders ---------------------------- */

async function loadPeople(userIds) {
  const User = require('../models/User');
  const SellerProfile = require('../models/SellerProfile');
  const ids = [...new Set(userIds.map(String))];
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('_id name kyc pitCommitment.personalTaxCode').lean(),
    SellerProfile.find({ user: { $in: ids } }).select('user sellerType legalName taxCode businessAddress').lean(),
  ]);
  const byProfile = new Map(profiles.map((p) => [String(p.user), p]));
  const out = new Map();
  for (const u of users) {
    const p = byProfile.get(String(u._id)) || {};
    const k = u.kyc || {};
    out.set(String(u._id), {
      sellerType: p.sellerType,
      legalName: p.legalName || k.orgName || k.fullName || u.name || '',
      fullName: k.fullName || u.name || '',
      taxCode: p.taxCode || k.personalTaxCode || u.pitCommitment?.personalTaxCode || '',
      idNumber: k.idNumber || '',
      address: p.businessAddress || k.orgAddress || '',
    });
  }
  return out;
}

async function buildQuarterlyReport({ year, quarter }) {
  const Order = require('../models/Order');
  const AffiliateCommission = require('../models/AffiliateCommission');
  const range = quarterRange(year, quarter);
  const [orders, commissions] = await Promise.all([
    Order.find({
      ownershipType: { $ne: 'PLATFORM_DIRECT' },
      status: { $in: ['paid', 'refunded'] },
      createdAt: { $gte: range.from, $lt: range.to },
    })
      .select('seller sellerType currency grossAmount amount refundAmount taxAmount taxPolicy createdAt')
      .lean(),
    AffiliateCommission.find({ createdAt: { $gte: range.from, $lt: range.to } })
      .select('affiliate currency amount amountVnd netAmount reversedAmount pitAmount pitCommitmentApplied createdAt status')
      .lean(),
  ]);
  const people = await loadPeople([...orders.map((o) => o.seller), ...commissions.map((c) => c.affiliate)]);
  const sellers = buildSellerRows(orders, people);
  const affiliates = buildAffiliateRows(commissions, people);
  return {
    year: range.year,
    quarter: range.quarter,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    filingMonth: range.filingMonth,
    filingYear: range.filingYear,
    sellers,
    affiliates,
    totals: totals(sellers, affiliates),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Year-end PIT withholding certificate data: affiliates (PIT on commissions) and individual sellers
 * (PIT part of the withholding). `affiliateId` limits to one person (self-service view).
 */
async function buildPitCertificates({ year, affiliateId } = {}) {
  const AffiliateCommission = require('../models/AffiliateCommission');
  const Order = require('../models/Order');
  const range = yearRange(year);
  const q = { createdAt: { $gte: range.from, $lt: range.to } };
  const [commissions, orders] = await Promise.all([
    AffiliateCommission.find(affiliateId ? { ...q, affiliate: affiliateId } : q).lean(),
    Order.find({
      ...q,
      ...(affiliateId ? { seller: affiliateId } : {}),
      ownershipType: { $ne: 'PLATFORM_DIRECT' },
      status: { $in: ['paid', 'refunded'] },
      'taxPolicy.withheldByPlatform': true,
    })
      .select('seller sellerType currency grossAmount amount refundAmount taxAmount taxPolicy createdAt')
      .lean(),
  ]);
  const people = await loadPeople([...commissions.map((c) => c.affiliate), ...orders.map((o) => o.seller)]);
  const aff = buildAffiliateRows(commissions, people).map((r) => ({
    kind: 'AFFILIATE',
    personId: r.affiliateId,
    fullName: r.fullName,
    taxCode: r.taxCode,
    idNumber: r.idNumber,
    address: r.address,
    year: range.year,
    fromMonth: r.firstMonth,
    toMonth: r.lastMonth,
    payments: r.payments,
    totalIncomeVnd: r.incomeVnd,
    totalPitWithheldVnd: r.pitWithheldVnd,
    incomeType: 'Thu nhập từ hoa hồng đại lý / tiền công (affiliate)',
  }));
  const sel = buildSellerRows(orders, people)
    .filter((r) => r.sellerType !== 'HOUSEHOLD_BUSINESS')
    .map((r) => ({
      kind: 'SELLER_INDIVIDUAL',
      personId: r.sellerId,
      fullName: r.legalName,
      taxCode: r.taxCode,
      idNumber: r.idNumber,
      address: r.address,
      year: range.year,
      fromMonth: 1,
      toMonth: 12,
      payments: r.orders,
      totalIncomeVnd: r.netRevenueVnd,
      totalPitWithheldVnd: r.pitWithheldVnd,
      totalVatWithheldVnd: r.vatWithheldVnd,
      incomeType: 'Doanh thu kinh doanh của cá nhân trên sàn TMĐT (NĐ 117/2025/NĐ-CP)',
    }));
  return [...aff, ...sel];
}

function renderPitCertificates(rows, year, format = 'xlsx') {
  const header = ['Loại', 'Mã người nộp thuế trên sàn', 'Họ tên', 'MST', 'Số CCCD', 'Địa chỉ', 'Năm', 'Từ tháng', 'Đến tháng', 'Số lần chi trả / số đơn', 'Khoản thu nhập', 'Tổng thu nhập chịu thuế (VND)', 'Thuế TNCN đã khấu trừ (VND)', 'GTGT đã khấu trừ (VND)'];
  const table = [header, ...rows.map((r) => [r.kind, r.personId, r.fullName, r.taxCode, r.idNumber, r.address, r.year, r.fromMonth, r.toMonth, r.payments, r.incomeType, r.totalIncomeVnd, r.totalPitWithheldVnd, r.totalVatWithheldVnd || 0])];
  const f = String(format || 'xlsx').toLowerCase();
  if (f === 'json') return { contentType: 'application/json', filename: `chung-tu-khau-tru-tncn-${year}.json`, body: JSON.stringify(rows) };
  if (f === 'csv') return { contentType: 'text/csv; charset=utf-8', filename: `chung-tu-khau-tru-tncn-${year}.csv`, body: buildCsv(table) };
  return { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `chung-tu-khau-tru-tncn-${year}.xlsx`, body: buildXlsx([{ name: `TNCN ${year}`, rows: table }]) };
}

module.exports = {
  quarterRange,
  yearRange,
  buildSellerRows,
  buildAffiliateRows,
  renderQuarterlyReport,
  renderPitCertificates,
  buildQuarterlyReport,
  buildPitCertificates,
  totals,
};
