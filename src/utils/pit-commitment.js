/**
 * Affiliate PIT commitment (Cam kết Mẫu 08/CK-TNCN). Pure helpers shared by routes and the
 * affiliate service. A commitment is per tax year; only an APPROVED one for the payment's year
 * exempts the affiliate from the 10% withholding on commission payments >= 2,000,000 VND.
 */
const PIT_COMMITMENT_SIDE = 'pit-commitment';
const PIT_COMMITMENT_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];

/** Calendar year in Asia/Bangkok (UTC+7). */
function vnYear(at = new Date()) {
  return new Date(new Date(at).getTime() + 7 * 3600 * 1000).getUTCFullYear();
}

function pitCommitmentOf(user) {
  const c = user?.pitCommitment;
  return c && typeof c === 'object' ? c : {};
}

function isPitCommitmentApproved(user, at = new Date()) {
  const c = pitCommitmentOf(user);
  return c.status === 'approved' && Number(c.year) === vnYear(at);
}

function mapPitCommitment(user, at = new Date()) {
  const c = pitCommitmentOf(user);
  return {
    status: c.status || 'none',
    year: c.year || null,
    hasDocument: !!c.objectName,
    personalTaxCode: c.personalTaxCode || '',
    submittedAt: c.submittedAt || null,
    reviewedAt: c.reviewedAt || null,
    rejectReason: c.rejectReason || '',
    activeForCurrentYear: isPitCommitmentApproved(user, at),
    currentYear: vnYear(at),
    form: 'Mẫu 08/CK-TNCN',
  };
}

/** Validate a submission. Year must be the current or next tax year. */
function parsePitCommitmentSubmission(body = {}, user, at = new Date()) {
  const c = pitCommitmentOf(user);
  if (!c.objectName) return { ok: false, code: 'NO_DOCUMENT', message: 'Upload the signed Mẫu 08/CK-TNCN first.' };
  if (c.status === 'pending') return { ok: false, code: 'PIT_COMMITMENT_PENDING', message: 'Already submitted; awaiting review.' };
  const now = vnYear(at);
  const year = Number(body.year || now);
  if (!Number.isInteger(year) || year < now || year > now + 1) {
    return { ok: false, code: 'INVALID_YEAR', message: 'The commitment must cover the current or the next tax year.' };
  }
  const taxCode = String(body.personalTaxCode || user?.kyc?.personalTaxCode || user?.kyc?.idNumber || '').replace(/\s+/g, '');
  if (!/^\d{10}$|^\d{12}$/.test(taxCode)) {
    return { ok: false, code: 'TAX_CODE_REQUIRED', message: 'Personal tax code (10 digits) or CCCD number (12 digits) is required.' };
  }
  return { ok: true, data: { year, personalTaxCode: taxCode } };
}

module.exports = {
  PIT_COMMITMENT_SIDE,
  PIT_COMMITMENT_MIMES,
  vnYear,
  pitCommitmentOf,
  isPitCommitmentApproved,
  mapPitCommitment,
  parsePitCommitmentSubmission,
};
