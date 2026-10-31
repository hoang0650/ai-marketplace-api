/**
 * Manual VietQR bank-transfer top-up (no payment intermediary).
 * The user transfers to the company account with a unique memo; an admin
 * matches the memo on the bank statement and credits the wallet by hand.
 *
 * Env (all optional except the account fields for the feature to be shown):
 *   BANK_NAME=VPBank
 *   BANK_ACCOUNT=<account number>
 *   BANK_ACCOUNT_NAME=<account holder, uppercase no diacritics>
 *   BANK_BIN=970432            (NAPAS BIN, VPBank = 970432)
 *   VND_USD_RATE=26500         (last-resort fallback only; live rate is the exchange-rate service)
 *   BANK_TOPUP_MIN_VND=10000   BANK_TOPUP_MAX_VND=500000000
 *   BANK_TOPUP_EXPIRE_HOURS=72
 */
const { DEFAULT_VND_PER_USD } = require('./fx');

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function bankTransferConfig(env = process.env) {
  const bankName = String(env.BANK_NAME || 'VPBank').trim();
  const accountNumber = String(env.BANK_ACCOUNT || '').trim();
  const accountName = String(env.BANK_ACCOUNT_NAME || '').trim().toUpperCase();
  const bin = String(env.BANK_BIN || '970432').trim();
  return {
    enabled: !!(accountNumber && accountName && /^\d{6}$/.test(bin)),
    bankName,
    accountNumber,
    accountName,
    bin,
    vndPerUsd: num(env.VND_USD_RATE, DEFAULT_VND_PER_USD),
    minVnd: num(env.BANK_TOPUP_MIN_VND, 10000),
    maxVnd: num(env.BANK_TOPUP_MAX_VND, 500_000_000),
    expireHours: num(env.BANK_TOPUP_EXPIRE_HOURS, 72),
  };
}

module.exports = { bankTransferConfig };
