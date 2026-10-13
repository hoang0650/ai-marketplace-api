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

module.exports = { parseBankAccount, maskAccountNumber };
