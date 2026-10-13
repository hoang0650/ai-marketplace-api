/**
 * Bank account a buyer gives with a wallet withdrawal (buyers have no seller profile / payout account on file).
 */
function clean(v, max) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** @returns {{ok:true,data:{bankName,accountNumber,accountName}} | {ok:false,code,message}} */
function parseBankAccount(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const bankName = clean(b.bankName, 100);
  const accountNumber = String(b.accountNumber ?? '').replace(/[\s.-]/g, '');
  const accountName = clean(b.accountName, 100);
  if (!bankName && !accountNumber && !accountName) {
    return { ok: false, code: 'BANK_ACCOUNT_REQUIRED', message: 'Bank name, account number and account holder are required' };
  }
  if (bankName.length < 2) return { ok: false, code: 'INVALID_BANK_NAME', message: 'Bank name is required' };
  if (!/^\d{6,20}$/.test(accountNumber)) {
    return { ok: false, code: 'INVALID_ACCOUNT_NUMBER', message: 'Account number must be 6–20 digits' };
  }
  if (accountName.length < 2) return { ok: false, code: 'INVALID_ACCOUNT_NAME', message: 'Account holder name is required' };
  return { ok: true, data: { bankName, accountNumber, accountName } };
}

function maskAccountNumber(n) {
  const s = String(n || '');
  return s.length <= 4 ? s : `${'•'.repeat(Math.min(6, s.length - 4))}${s.slice(-4)}`;
}

/** Uppercase, no Vietnamese diacritics, single spaces: "Nguyễn  Văn A" → "NGUYEN VAN A". */
function normalizeHolderName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** The account holder must be the verified person (or, for organizations, the business name). */
function holderMatchesKyc(accountName, kyc) {
  const want = normalizeHolderName(accountName);
  if (!want) return false;
  const k = kyc || {};
  const names = [k.fullName];
  if (k.subjectType === 'organization') names.push(k.orgName);
  return names.some((n) => n && normalizeHolderName(n) === want);
}

function hasPayoutAccount(acc) {
  return Boolean(acc && acc.bankName && acc.accountNumber && acc.accountName);
}

/** Owner view: full number (it is their own data) plus a masked copy for display. */
function mapPayoutAccount(acc) {
  if (!hasPayoutAccount(acc)) return null;
  return {
    bankName: acc.bankName,
    accountNumber: acc.accountNumber,
    accountNumberMasked: maskAccountNumber(acc.accountNumber),
    accountName: acc.accountName,
    updatedAt: acc.updatedAt ? new Date(acc.updatedAt).toISOString() : null,
  };
}

module.exports = {
  parseBankAccount,
  maskAccountNumber,
  normalizeHolderName,
  holderMatchesKyc,
  hasPayoutAccount,
  mapPayoutAccount,
};
