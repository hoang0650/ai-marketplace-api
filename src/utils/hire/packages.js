'use strict';

const { httpError, roundMoney } = require('./rules');

const MAX_PACKAGES = 12;
const MAX_DELIVERABLES = 20;
/** USD stays on the existing commercial cap. VND is an integer dong amount. */
const MAX_PACKAGE_USD = 100_000;
const MAX_PACKAGE_VND = 1_000_000_000;

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

function packageCurrency(raw) {
  const code = clean(raw || 'USD', 8).normalize('NFC').toUpperCase();
  if (code === 'USD') return 'USD';
  if (code === 'VND' || code === 'VNĐ') return 'VND';
  return '';
}

function packagePrice(raw, currency) {
  const n = Number(raw);
  if (currency === 'VND') {
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PACKAGE_VND) return null;
    return n;
  }
  const price = roundMoney(n);
  if (!(price > 0) || price > MAX_PACKAGE_USD) return null;
  return price;
}

function packageCode(raw, index) {
  const slug = clean(raw, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || `package-${index + 1}`;
}

/**
 * Seller-defined professional-service packages. Each one has a scope,
 * deliverables, a duration and a fixed price. Empty input means the listing
 * still sells its single package price.
 */
function normalizeServicePackages(raw) {
  if (raw == null) return { packages: undefined };
  if (!Array.isArray(raw)) {
    return { error: { code: 'SERVICE_PACKAGES_INVALID', message: 'Danh sách gói dịch vụ không hợp lệ.' } };
  }
  if (raw.length > MAX_PACKAGES) {
    return { error: { code: 'SERVICE_PACKAGES_TOO_MANY', message: `Tối đa ${MAX_PACKAGES} gói.` } };
  }
  const seen = new Set();
  const packages = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i] || {};
    const code = packageCode(row.code || row.name, i);
    if (seen.has(code)) {
      return { error: { code: 'SERVICE_PACKAGE_CODE_DUPLICATE', message: 'Mỗi gói cần một mã riêng.' } };
    }
    seen.add(code);
    const name = clean(row.name, 120);
    const scope = clean(row.scope, 2000);
    const deliverables = (Array.isArray(row.deliverables) ? row.deliverables : [])
      .map((item) => clean(item, 200))
      .filter(Boolean)
      .slice(0, MAX_DELIVERABLES);
    const durationDays = Math.round(Number(row.durationDays));
    const currency = packageCurrency(row.currency);
    if (!name || !scope || !deliverables.length) {
      return { error: { code: 'SERVICE_PACKAGE_FIELDS', message: 'Mỗi gói cần tên, phạm vi và ít nhất một hạng mục bàn giao.' } };
    }
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365) {
      return { error: { code: 'SERVICE_PACKAGE_DURATION', message: 'Thời lượng gói là số ngày từ 1 đến 365.' } };
    }
    if (!currency) {
      return { error: { code: 'SERVICE_PACKAGE_CURRENCY', message: 'Gói chỉ nhận USD hoặc VND.' } };
    }
    const price = packagePrice(row.price, currency);
    if (price == null) {
      return {
        error: {
          code: 'SERVICE_PACKAGE_PRICE',
          message: currency === 'VND'
            ? 'Giá gói VND phải là số nguyên từ 1 đến 1.000.000.000.'
            : 'Giá gói USD phải lớn hơn 0 và không quá 100.000.',
        },
      };
    }
    const phases = Array.isArray(row.phases)
      ? row.phases
          .map((phase) => ({
            title: clean(phase?.title, 200),
            percent: Number(phase?.percent) || 0,
            days: Math.round(Number(phase?.days) || 0),
          }))
          .filter((phase) => phase.percent > 0 && phase.days > 0)
          .slice(0, 10)
      : [];
    const phaseSum = phases.reduce((sum, phase) => sum + phase.percent, 0);
    packages.push({
      code,
      name,
      scope,
      deliverables,
      durationDays,
      price,
      currency,
      ...(phases.length && Math.abs(phaseSum - 100) < 0.01 ? { phases } : {}),
    });
  }
  return { packages };
}

function selectServicePackage(product, packageCodeRaw) {
  const packages = Array.isArray(product?.servicePackages) ? product.servicePackages : [];
  if (!packages.length) {
    const price = roundMoney(product?.pricing?.price);
    if (!(price > 0)) throw httpError(400, 'SERVICE_PRICE_REQUIRED');
    return {
      code: 'default',
      name: product?.name || 'Gói dịch vụ',
      scope: String(product?.description || '').slice(0, 2000),
      deliverables: [],
      durationDays: Math.round(Number(product?.serviceDeliveryDays) || 21),
      price,
      currency: product?.pricing?.currency || 'USD',
      phases: product?.servicePlan,
    };
  }
  const code = String(packageCodeRaw || '').trim().toLowerCase();
  const found = packages.find((row) => row.code === code);
  if (!found) throw httpError(400, 'SERVICE_PACKAGE_REQUIRED');
  return found;
}

function normalizePaymentChoice(raw) {
  const choice = raw == null || raw === '' ? 'staged' : String(raw).trim().toLowerCase();
  if (choice !== 'staged' && choice !== 'prepaid') throw httpError(400, 'PAYMENT_CHOICE_INVALID');
  return choice;
}

module.exports = {
  MAX_PACKAGE_USD,
  MAX_PACKAGE_VND,
  normalizeServicePackages,
  selectServicePackage,
  normalizePaymentChoice,
  packagePrice,
};
