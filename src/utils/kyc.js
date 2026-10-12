const User = require('../models/User');

/** Two sides of the ID document (CCCD / passport) — required for every applicant. */
const KYC_SIDES = ['front', 'back'];
/**
 * Business registration certificate scan/photo (Giấy chứng nhận đăng ký hộ kinh doanh /
 * đăng ký doanh nghiệp / giấy phép kinh doanh) — required for organizations (Quy chế 2.1, Mục VIII.2).
 */
const LICENSE_SIDE = 'license';
const KYC_DOC_SIDES = [...KYC_SIDES, LICENSE_SIDE];

// VN tax codes: enterprise 10 digits (+ "-NNN" for branches). Since 01/07/2025 individuals and
// household businesses use the 12-digit personal identification number; legacy 10-digit codes stay valid.
const PERSONAL_TAX_RE = /^(\d{10}|\d{12})$/;
const COMPANY_TAX_RE = /^\d{10}(-\d{3})?$/;
const HOUSEHOLD_TAX_RE = /^(\d{10}(-\d{3})?|\d{12})$/;

function kycOf(user) {
  return user?.kyc && typeof user.kyc === 'object' ? user.kyc : {};
}

function kycStatus(user) {
  const s = String(kycOf(user).status || 'none');
  return User.KYC_STATUSES.includes(s) ? s : 'none';
}

/** Non-admin must be verified to withdraw. */
function assertCanWithdrawKyc(user) {
  if (!user) return { ok: false, code: 'UNAUTHORIZED', message: 'Unauthorized' };
  if (user.role === 'admin') return { ok: true };
  const status = kycStatus(user);
  if (status === 'verified') return { ok: true };
  const messages = {
    none: 'Complete identity verification (eKYC) before withdrawing.',
    draft: 'Finish and submit your eKYC documents before withdrawing.',
    pending: 'Your identity verification is under review. Withdrawals unlock after approval.',
    rejected: 'Your eKYC was rejected. Update documents and resubmit before withdrawing.',
  };
  return {
    ok: false,
    code: 'KYC_REQUIRED',
    kycStatus: status,
    message: messages[status] || messages.none,
  };
}

function hasDoc(kyc, side) {
  const key = `${side}ObjectName`;
  return Boolean(String(kyc?.[key] || '').trim());
}

function subjectTypeOf(kyc) {
  return User.KYC_SUBJECT_TYPES.includes(kyc?.subjectType) ? kyc.subjectType : 'individual';
}

function mapKyc(user, { includeSensitive = false } = {}) {
  const k = kycOf(user);
  const status = kycStatus(user);
  const subjectType = subjectTypeOf(k);
  const base = {
    status,
    subjectType,
    fullName: k.fullName || '',
    idType: k.idType || 'cccd',
    idNumberMasked: maskId(k.idNumber),
    personalTaxCodeMasked: maskId(k.personalTaxCode),
    orgType: subjectType === 'organization' ? k.orgType || '' : '',
    orgName: subjectType === 'organization' ? k.orgName || '' : '',
    orgTaxCode: subjectType === 'organization' ? k.orgTaxCode || '' : '',
    orgAddress: subjectType === 'organization' ? k.orgAddress || '' : '',
    hasFront: hasDoc(k, 'front'),
    hasBack: hasDoc(k, 'back'),
    hasLicense: hasDoc(k, LICENSE_SIDE),
    licenseRequired: subjectType === 'organization',
    submittedAt: k.submittedAt ? new Date(k.submittedAt).toISOString() : null,
    reviewedAt: k.reviewedAt ? new Date(k.reviewedAt).toISOString() : null,
    rejectReason: k.rejectReason || '',
    canSubmit: canSubmit(k, status),
    canEdit: status === 'none' || status === 'draft' || status === 'rejected',
    withdrawAllowed: status === 'verified' || user?.role === 'admin',
  };
  if (!includeSensitive) return base;
  return {
    ...base,
    idNumber: k.idNumber || '',
    personalTaxCode: k.personalTaxCode || '',
    frontObjectName: k.frontObjectName || '',
    backObjectName: k.backObjectName || '',
    licenseObjectName: k.licenseObjectName || '',
  };
}

/** Document sides an applicant must upload: ID front/back, plus the business licence for organizations. */
function requiredSides(subjectType) {
  return subjectType === 'organization' ? KYC_DOC_SIDES : KYC_SIDES;
}

function canSubmit(kyc, status, subjectType = subjectTypeOf(kyc)) {
  if (status === 'pending' || status === 'verified') return false;
  return requiredSides(subjectType).every((side) => hasDoc(kyc, side));
}

function maskId(raw) {
  const s = String(raw || '').trim();
  if (s.length <= 4) return s ? '••••' : '';
  return `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

function objectNameForSide(kyc, side) {
  if (!KYC_DOC_SIDES.includes(side)) return '';
  return String(kyc?.[`${side}ObjectName`] || '').trim();
}

function normalizeTaxCode(raw) {
  return String(raw || '')
    .replace(/[\s.]/g, '')
    .slice(0, 20);
}

const clean = (v, max) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, max);

/**
 * Validates a submit body. Individual: person + personal tax code.
 * Organization: household business / company + its tax code, name, address; the ID
 * documents and name belong to the legal representative (household owner).
 * @returns {{ ok: true, data: object } | { ok: false, code: string, message: string }}
 */
function parseKycSubmission(body, fallbackName = '') {
  const b = body || {};
  const fail = (code, message) => ({ ok: false, code, message });

  const subjectType = String(b.subjectType || 'individual').trim();
  if (!User.KYC_SUBJECT_TYPES.includes(subjectType)) return fail('INVALID_SUBJECT_TYPE', 'Invalid subjectType');

  const fullName = clean(b.fullName || fallbackName, 200);
  if (fullName.length < 2) {
    return fail(
      'NAME_REQUIRED',
      subjectType === 'organization' ? 'Legal representative name is required' : 'Full legal name is required',
    );
  }
  const idType = String(b.idType || 'cccd').trim();
  if (!User.KYC_ID_TYPES.includes(idType)) return fail('INVALID_ID_TYPE', 'Invalid idType');
  const idNumber = String(b.idNumber || '').replace(/\s+/g, '').slice(0, 64);
  if (idNumber.length < 6) return fail('ID_REQUIRED', 'ID number is required (min 6 characters)');

  const data = {
    subjectType,
    fullName,
    idType,
    idNumber,
    personalTaxCode: '',
    orgType: '',
    orgName: '',
    orgTaxCode: '',
    orgAddress: '',
  };

  if (subjectType === 'individual') {
    const personalTaxCode = normalizeTaxCode(b.personalTaxCode);
    if (!PERSONAL_TAX_RE.test(personalTaxCode)) {
      return fail('INVALID_PERSONAL_TAX_CODE', 'Personal tax code must be 10 digits or the 12-digit personal ID number');
    }
    data.personalTaxCode = personalTaxCode;
    return { ok: true, data };
  }

  const orgType = String(b.orgType || '').trim();
  if (!User.KYC_ORG_TYPES.includes(orgType)) return fail('INVALID_ORG_TYPE', 'orgType must be household or company');
  const orgName = clean(b.orgName, 300);
  if (orgName.length < 3) return fail('ORG_NAME_REQUIRED', 'Business name is required');
  const orgTaxCode = normalizeTaxCode(b.orgTaxCode);
  const taxRe = orgType === 'company' ? COMPANY_TAX_RE : HOUSEHOLD_TAX_RE;
  if (!taxRe.test(orgTaxCode)) {
    return fail(
      'INVALID_ORG_TAX_CODE',
      orgType === 'company'
        ? 'Business tax code must be 10 digits (or 10-3 digits for a branch)'
        : 'Household business tax code must be 10 digits, 10-3 digits, or the 12-digit owner ID number',
    );
  }
  const orgAddress = clean(b.orgAddress, 500);
  if (orgAddress.length < 10) return fail('ORG_ADDRESS_REQUIRED', 'Registered business address is required');

  Object.assign(data, { orgType, orgName, orgTaxCode, orgAddress });
  return { ok: true, data };
}

module.exports = {
  KYC_SIDES,
  KYC_DOC_SIDES,
  LICENSE_SIDE,
  requiredSides,
  kycOf,
  kycStatus,
  assertCanWithdrawKyc,
  mapKyc,
  canSubmit,
  objectNameForSide,
  hasDoc,
  normalizeTaxCode,
  parseKycSubmission,
};
