const { normalizeHolderName } = require('../utils/payout-account');

/**
 * Affiliate commission is not marketplace credit.
 * The only permitted use is a VND payout to the affiliate's own registered bank account
 * (after reconciliation, the 48h hold, and payment within 7 working days).
 * It cannot pay for an order or service, and it cannot be moved into spendable wallet balance.
 */
const COMMISSION_BANK_ONLY_MESSAGE =
  'Hoa hồng chỉ được rút về tài khoản ngân hàng của người tiếp thị liên kết.';
const COMMISSION_BANK_ONLY_CODE = 'COMMISSION_BANK_PAYOUT_ONLY';

const WALLET_TARGETS = new Set([
  'wallet',
  'internal',
  'internal_wallet',
  'internal_ledger',
  'internal_balance',
  'balance',
  'ledger',
  'spendable',
  'to_wallet',
  'withdraw_to_wallet',
  'convert',
  'convert_to_wallet',
  'convert_commission',
  'transfer',
  'transfer_to_wallet',
  'transfer_to_balance',
  'commission_to_wallet',
  'commission_to_balance',
  'vi',
  'vi_noi_bo',
]);

const TRANSFER_FIELDS = [
  'destination',
  'target',
  'payoutTo',
  'convertTo',
  'transferTo',
  'withdrawTo',
  'method',
  'channel',
  'payoutMethod',
  'settleTo',
];

const COMMISSION_SOURCES = new Set([
  'affiliate',
  'affiliate_commission',
  'affiliate_balance',
  'commission',
  'hoa_hong',
  'hoa_hong_tiep_thi',
]);

const SOURCE_FIELDS = ['paymentSource', 'payWith', 'fundSource', 'balanceSource', 'walletSource', 'source'];

function token(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function denial(status = 403) {
  return {
    ok: false,
    status,
    code: COMMISSION_BANK_ONLY_CODE,
    message: COMMISSION_BANK_ONLY_MESSAGE,
  };
}

/** Body asks to move commission into internal / spendable wallet balance. */
function commissionToWalletRequest(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.convertToWallet === true || body.transferToWallet === true || body.toWallet === true) return true;
  const action = token(body.action || body.intent);
  if (WALLET_TARGETS.has(action)) return true;
  return TRANSFER_FIELDS.some((key) => WALLET_TARGETS.has(token(body[key])));
}

/** Body asks checkout or a charge to take affiliate commission as the payment source. */
function commissionPaymentRequest(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.useCommission === true || body.payWithCommission === true) return true;
  return SOURCE_FIELDS.some((key) => COMMISSION_SOURCES.has(token(body[key])));
}

/** @returns {null | {ok:false, status:number, code:string, message:string}} */
function forbiddenCommissionUse(body) {
  if (commissionToWalletRequest(body) || commissionPaymentRequest(body)) return denial(403);
  return null;
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function normBank(name) {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function usableAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bankName = String(raw.bankName || '').replace(/\s+/g, ' ').trim();
  const accountNumber = digits(raw.accountNumber);
  const accountName = String(raw.accountName || '').replace(/\s+/g, ' ').trim();
  if (bankName.length < 2 || !/^\d{6,20}$/.test(accountNumber) || accountName.length < 2) return null;
  return { bankName, accountNumber, accountName };
}

function hasRequestedAccount(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return ['bankName', 'accountNumber', 'accountName'].some((key) => String(raw[key] || '').trim());
}

function sameRegisteredAccount(requested, saved) {
  if (!saved) return false;
  return digits(requested?.accountNumber) === saved.accountNumber
    && normBank(requested?.bankName) === normBank(saved.bankName)
    && normalizeHolderName(requested?.accountName) === normalizeHolderName(saved.accountName);
}

/**
 * Bank payout may use only the affiliate's saved payout account.
 * Omitting the account uses that registration. A different account is rejected.
 * Historical commission rows are not touched.
 */
function resolveAffiliateBankPayout({ requested = null, registered = null } = {}) {
  const saved = usableAccount(registered);
  if (!saved) {
    return {
      ok: false,
      status: 400,
      code: 'BANK_ACCOUNT_REQUIRED',
      message: 'Bank name, account number and account holder are required',
    };
  }
  if (hasRequestedAccount(requested) && !sameRegisteredAccount(requested, saved)) {
    return denial(403);
  }
  return {
    ok: true,
    account: { ...saved, source: 'registered' },
  };
}

/**
 * Affiliate withdrawal request: reject wallet conversion, otherwise require the registered bank account.
 * `payable` is the released commission that the ledger can still cover. No commercial minimum.
 */
function decideAffiliateWithdrawal({ body, registered, payoutPool = 0, affiliateAvailable = 0 } = {}) {
  const forbidden = forbiddenCommissionUse(body);
  if (forbidden) return forbidden;
  const bank = resolveAffiliateBankPayout({
    requested: body?.bankAccount || null,
    registered,
  });
  if (!bank.ok) return bank;
  const pool = Math.max(0, Number(payoutPool) || 0);
  const avail = Math.max(0, Number(affiliateAvailable) || 0);
  const payable = Math.round(Math.min(pool, avail) * 100) / 100;
  return { ok: true, account: bank.account, payable };
}

/**
 * Wallet credits written when a commission was recorded into the shared ledger.
 * These rows stay. They are a payout liability, not spendable balance.
 * There is no migration that rewrites them.
 */
function historicalCommissionCreditFilter() {
  return {
    type: 'credit',
    $or: [
      { 'meta.source': 'affiliate_commission' },
      { note: { $regex: '^Affiliate commission ' } },
    ],
  };
}

module.exports = {
  COMMISSION_BANK_ONLY_MESSAGE,
  COMMISSION_BANK_ONLY_CODE,
  commissionToWalletRequest,
  commissionPaymentRequest,
  forbiddenCommissionUse,
  resolveAffiliateBankPayout,
  decideAffiliateWithdrawal,
  historicalCommissionCreditFilter,
};
