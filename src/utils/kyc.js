const User = require('../models/User');

const KYC_SIDES = ['front', 'back', 'selfie'];

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

function mapKyc(user, { includeSensitive = false } = {}) {
  const k = kycOf(user);
  const status = kycStatus(user);
  const base = {
    status,
    fullName: k.fullName || '',
    idType: k.idType || 'cccd',
    idNumberMasked: maskId(k.idNumber),
    hasFront: hasDoc(k, 'front'),
    hasBack: hasDoc(k, 'back'),
    hasSelfie: hasDoc(k, 'selfie'),
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
    frontObjectName: k.frontObjectName || '',
    backObjectName: k.backObjectName || '',
    selfieObjectName: k.selfieObjectName || '',
  };
}

function canSubmit(kyc, status) {
  if (status === 'pending' || status === 'verified') return false;
  return hasDoc(kyc, 'front') && hasDoc(kyc, 'back') && hasDoc(kyc, 'selfie');
}

function maskId(raw) {
  const s = String(raw || '').trim();
  if (s.length <= 4) return s ? '••••' : '';
  return `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

function objectNameForSide(kyc, side) {
  if (!KYC_SIDES.includes(side)) return '';
  return String(kyc?.[`${side}ObjectName`] || '').trim();
}

module.exports = {
  KYC_SIDES,
  kycOf,
  kycStatus,
  assertCanWithdrawKyc,
  mapKyc,
  canSubmit,
  objectNameForSide,
  hasDoc,
};
