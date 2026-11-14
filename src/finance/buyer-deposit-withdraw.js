const { convertAmount } = require('./bank-topup-core');
const { holderMatchesKyc } = require('../utils/payout-account');
const { kycStatus } = require('../utils/kyc');

const SOURCE = 'vietqr_company_bank';
const APPSTORE = new Set(['iap', 'apple_pay', 'google_pay']);

const MESSAGES = {
  WITHDRAW_NOT_ACTIVATED: 'VietQR company-bank withdrawal is switched off. The switch is an operator control only. It does not decide payment licensing, and company-held buyer balances remain under legal review.',
  KYC_REQUIRED: 'Electronic identity (eKYC) must be verified before a VietQR company-bank deposit can be withdrawn. A manual tax-code review is not identity verification.',
  BANK_ACCOUNT_REQUIRED: 'Save a payout account in the verified eKYC name before withdrawing.',
  ACCOUNT_NAME_MISMATCH: 'The account holder name must match the verified eKYC name.',
  INVALID_AMOUNT: 'amountVnd must be a positive whole number of VND.',
  IDEMPOTENCY_KEY_INVALID: 'Idempotency-Key must be 8–120 characters: letters, digits, dot, underscore, colon or hyphen.',
  IDEMPOTENCY_CONFLICT: 'This idempotency key was already used for a different VietQR withdrawal.',
  PENDING_WITHDRAWAL: 'A VietQR withdrawal is already pending. No bank transfer has been sent.',
  APPSTORE_UNRESOLVED: 'Apple and Google top-ups are not withdrawn. Store payout terms are unresolved.',
  GPAY_REMOVED: 'A GPay top-up is not paid out by this VietQR request. New GPay checkout stays inactive while the project contract is still pending.',
  SOURCE_NOT_SEPARATED: 'The server could not prove a VietQR company-bank balance, so no withdrawal was created.',
  NOTHING_TO_WITHDRAW: 'There is no proven VietQR company-bank balance to withdraw.',
  DEPOSIT_CAP: 'The amount is above the proven VietQR balance that this wallet can fund.',
  EXCHANGE_RATE_UNAVAILABLE: 'Exchange rate is unavailable. Conversion waits for a rate from ExchangeRate-API (https://www.exchangerate-api.com).',
};

function centsOf(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

function usdOf(cents) {
  return Math.round(cents) / 100;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function addSafe(a, b) {
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
}

function eventTime(tx) {
  const t = new Date(tx?.createdAt).getTime();
  return Number.isFinite(t) ? t : null;
}

function cleanIdempotencyKey(raw) {
  if (raw == null || String(raw).trim() === '') return '';
  const s = String(raw).trim();
  return /^[A-Za-z0-9._:-]{8,120}$/.test(s) ? s : null;
}

function isVietqrDepositWithdrawalRequest(body) {
  return String(body?.source || '') === SOURCE;
}

/**
 * A company VietQR deposit is only the row the bank top-up writer stores:
 * method bank_transfer, kind bank_transfer_vietqr, integer VND and a positive rate.
 * Anything else that merely looks like a transfer stays unproven.
 */
function classifyDeposit(tx) {
  const method = String(tx?.paymentMethod || '');
  const kind = String(tx?.meta?.kind || '');
  const channel = String(tx?.meta?.channel || '');
  if (method === 'bank_transfer' && kind === 'bank_transfer_vietqr') {
    if (positiveInt(tx?.meta?.amountVnd) && Number(tx?.meta?.vndPerUsd) > 0 && centsOf(tx?.amount) > 0) return 'vietqr';
    return 'unproven';
  }
  if (method === 'bank_transfer' || kind === 'bank_transfer_vietqr' || channel === 'bank_transfer') return 'unproven';
  if (APPSTORE.has(method)) return 'appstore';
  if (method === 'gpay' || kind.startsWith('gpay') || channel.startsWith('gpay')) return 'gpay';
  if (method) return 'other';
  return 'unknown';
}

function isBuyerDepositWithdrawal(tx) {
  return tx?.type === 'withdraw' && (tx?.meta?.source === SOURCE || tx?.meta?.persona === 'buyer');
}

function consumeCents(lots, need) {
  let left = need;
  for (const lot of lots) {
    if (left <= 0) break;
    if (lot.cents <= 0) continue;
    const take = Math.min(lot.cents, left);
    const full = take === lot.cents;
    const vndTake = full || lot.vnd <= 0 ? (full ? lot.vnd : 0) : Math.min(lot.vnd, Math.ceil((take * lot.vnd) / lot.cents));
    lot.cents -= take;
    lot.vnd -= vndTake;
    left -= take;
  }
  return left;
}

function consumeVnd(lots, need) {
  let left = need;
  for (const lot of lots) {
    if (left <= 0) break;
    if (lot.vnd <= 0) continue;
    const take = Math.min(lot.vnd, left);
    const full = take === lot.vnd;
    const centsTake = full || lot.cents <= 0 ? (full ? lot.cents : 0) : Math.min(lot.cents, Math.ceil((take * lot.cents) / lot.vnd));
    lot.vnd -= take;
    lot.cents -= centsTake;
    left -= take;
  }
  return left;
}

function maxVndFunded(rate, fundableCents, capVnd) {
  if (!(rate > 0) || fundableCents <= 0 || capVnd <= 0) return 0;
  let lo = 0;
  let hi = capVnd;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const need = Math.round((mid / rate) * 100);
    if (need > 0 && need <= fundableCents) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Proven VietQR VND remaining after spends and earlier buyer withdrawals.
 * Spends consume open VietQR lots only, in ledger order. A spend that happened
 * before a deposit is not charged to that later deposit. Refund credits are
 * counted and never added. Unproven, app-store, GPay and other deposits are
 * excluded. The payable VND cannot cost more USD than the remaining deposit
 * cents or the pooled available USD.
 */
function buyerVietqrSnapshot(txs = [], poolAvailableUsd = 0, vndPerUsd = 0) {
  const events = [];
  let gap = false;
  let depositedVnd = 0;
  let depositedCents = 0;
  let appstoreCents = 0;
  let gpayCents = 0;
  let unknownCents = 0;
  let refundCents = 0;

  txs.forEach((tx, index) => {
    const status = tx?.status || 'completed';
    if (status === 'failed' || status === 'cancelled') return;
    const at = eventTime(tx);
    if (tx?.type === 'credit') {
      refundCents += centsOf(tx.amount);
      return;
    }
    if (tx?.type === 'deposit') {
      if (status !== 'completed') return;
      const kind = classifyDeposit(tx);
      const cents = centsOf(tx.amount);
      if (kind === 'vietqr') {
        const vnd = positiveInt(tx.meta.amountVnd);
        const nextVnd = addSafe(depositedVnd, vnd);
        const nextCents = addSafe(depositedCents, cents);
        if (at == null || nextVnd == null || nextCents == null) gap = true;
        else {
          depositedVnd = nextVnd;
          depositedCents = nextCents;
          events.push({ at, index, type: 'deposit', cents, vnd });
        }
      } else if (kind === 'appstore') appstoreCents += cents;
      else if (kind === 'gpay') gpayCents += cents;
      else unknownCents += cents;
      return;
    }
    if (tx?.type === 'debit' && (status === 'completed' || status === 'pending')) {
      const cents = centsOf(tx.amount);
      if (!cents) return;
      if (at == null) gap = true;
      else events.push({ at, index, type: 'spend', cents });
      return;
    }
    if (tx?.type === 'withdraw' && (status === 'completed' || status === 'pending') && isBuyerDepositWithdrawal(tx)) {
      const vnd = positiveInt(tx?.meta?.amountVnd);
      if (!vnd || at == null) gap = true;
      else events.push({ at, index, type: 'withdraw', cents: centsOf(tx.amount), vnd });
    }
  });

  events.sort((a, b) => (a.at - b.at) || (a.index - b.index));
  const lots = [];
  for (const event of events) {
    if (event.type === 'deposit') lots.push({ cents: event.cents, vnd: event.vnd });
    else if (event.type === 'spend') consumeCents(lots, event.cents);
    else if (consumeVnd(lots, event.vnd) > 0) gap = true;
  }

  let remainingVnd = 0;
  let remainingCents = 0;
  for (const lot of lots) {
    const nextVnd = addSafe(remainingVnd, Math.max(0, lot.vnd));
    const nextCents = addSafe(remainingCents, Math.max(0, lot.cents));
    if (nextVnd == null || nextCents == null) gap = true;
    else {
      remainingVnd = nextVnd;
      remainingCents = nextCents;
    }
  }

  const blockedSources = [];
  if (appstoreCents > 0) blockedSources.push('appstore');
  if (gpayCents > 0) blockedSources.push('gpay');
  if (unknownCents > 0) blockedSources.push('unknown');

  const rate = Number(vndPerUsd);
  const fxAvailable = rate > 0;
  const poolCents = Math.max(0, centsOf(poolAvailableUsd));
  let payableVnd = 0;
  let payableUsd = 0;
  if (!gap && fxAvailable) {
    const fundableCents = Math.min(poolCents, remainingCents);
    payableVnd = maxVndFunded(rate, fundableCents, remainingVnd);
    if (payableVnd > 0) {
      const conv = convertAmount({ amount: payableVnd, currency: 'VND' }, rate);
      const need = conv ? centsOf(conv.amountUsd) : fundableCents + 1;
      if (!conv || need <= 0 || need > fundableCents) payableVnd = 0;
      else payableUsd = conv.amountUsd;
    }
  }

  return {
    fundingSeparated: true,
    settlement: 'VND',
    refundsIncluded: false,
    refundsSeparate: true,
    provenance: gap ? 'unresolved' : fxAvailable ? 'proven' : 'fx_unavailable',
    vietqrDepositedVnd: depositedVnd,
    vietqrDepositedUsd: usdOf(depositedCents),
    remainingVnd,
    payableVnd,
    payableUsd,
    appstoreUsd: usdOf(appstoreCents),
    gpayUsd: usdOf(gpayCents),
    unknownUsd: usdOf(unknownCents),
    refundCreditsUsd: usdOf(refundCents),
    blockedSources,
    fxAvailable,
    fxLimited: !gap && fxAvailable && payableVnd < remainingVnd,
    vndPerUsd: fxAvailable ? rate : null,
    transferExecuted: false,
  };
}

/**
 * Operator switch for the new buyer VietQR cash-out path. Default is closed.
 * `true` / `1` opens the technical path only. It is not a payment-license finding.
 */
function buyerVietqrWithdrawActivated(env = process.env) {
  const raw = String(env?.BUYER_VIETQR_WITHDRAW_ENABLED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

function publicBuyerDepositWithdraw(snapshot, { electronicIdentityStatus = 'none', poolKnown = true, activated = false } = {}) {
  const proven = poolKnown && snapshot?.provenance === 'proven';
  const blockedSources = [...(snapshot?.blockedSources || [])];
  if (!proven && !blockedSources.includes('unknown')) blockedSources.push('unknown');
  return {
    enabled: activated === true,
    legalAuthorization: 'unresolved',
    paymentAuthorization: 'unresolved',
    paymentModel: 'authorized_holder_not_selected',
    companyCollectionAccountIsNotPsp: true,
    providerSelected: false,
    fundingSeparated: true,
    settlement: 'VND',
    refundsSeparate: true,
    electronicIdentityStatus,
    payableUsd: proven ? Number(snapshot.payableUsd) || 0 : 0,
    payableVnd: proven && Number.isInteger(snapshot.payableVnd) ? snapshot.payableVnd : 0,
    blockedSources: proven ? snapshot.blockedSources || [] : blockedSources,
    source: SOURCE,
    provenance: poolKnown ? snapshot?.provenance || 'unresolved' : 'unresolved',
    fxLimited: proven ? snapshot.fxLimited === true : false,
    vndPerUsd: snapshot?.vndPerUsd ?? null,
    transferExecuted: false,
  };
}

function refusal(status, code, snapshot) {
  return {
    ok: false,
    status,
    code,
    message: MESSAGES[code] || MESSAGES.SOURCE_NOT_SEPARATED,
    payableVnd: snapshot?.payableVnd || 0,
    payableUsd: snapshot?.payableUsd || 0,
    blockedSources: snapshot?.blockedSources || [],
  };
}

function zeroReason(snapshot) {
  if (snapshot.provenance !== 'proven') return 'SOURCE_NOT_SEPARATED';
  if ((snapshot.vietqrDepositedVnd || 0) <= 0 && (snapshot.blockedSources || []).includes('appstore')) return 'APPSTORE_UNRESOLVED';
  if ((snapshot.vietqrDepositedVnd || 0) <= 0 && (snapshot.blockedSources || []).includes('gpay')) return 'GPAY_REMOVED';
  if ((snapshot.vietqrDepositedVnd || 0) <= 0 && (snapshot.blockedSources || []).includes('unknown')) return 'SOURCE_NOT_SEPARATED';
  return 'NOTHING_TO_WITHDRAW';
}

/**
 * Decide a withdrawal from rows already read inside the wallet lock.
 * Does not write. Identity is user.kyc.status only; role never bypasses it.
 */
function decideBuyerVietqrWithdrawal({
  user,
  amountVnd,
  idempotencyKey,
  account,
  rows = [],
  poolAvailableUsd = 0,
  vndPerUsd = 0,
  fx = {},
  activated = false,
} = {}) {
  const key = cleanIdempotencyKey(idempotencyKey);
  if (key == null) return refusal(400, 'IDEMPOTENCY_KEY_INVALID', null);
  const snapshot = buyerVietqrSnapshot(rows, poolAvailableUsd, vndPerUsd);
  if (activated !== true) return refusal(403, 'WITHDRAW_NOT_ACTIVATED', snapshot);
  const identityOk = kycStatus(user) === 'verified';
  if (!identityOk) {
    const denied = refusal(403, 'KYC_REQUIRED', snapshot);
    denied.electronicIdentityStatus = kycStatus(user);
    return denied;
  }
  if (!positiveInt(amountVnd)) return refusal(400, 'INVALID_AMOUNT', snapshot);

  const active = (rows || []).filter((tx) => isBuyerDepositWithdrawal(tx));
  if (key) {
    const prior = active.find((tx) => tx?.meta?.idempotencyKey === key);
    if (prior) {
      const dead = prior.status === 'failed' || prior.status === 'cancelled';
      if (dead || positiveInt(prior?.meta?.amountVnd) !== amountVnd) return refusal(409, 'IDEMPOTENCY_CONFLICT', snapshot);
      return { ok: true, replay: prior, snapshot };
    }
  }
  const pending = active.filter((tx) => (tx.status || 'completed') === 'pending');
  if (pending.length > 1) return refusal(409, 'PENDING_WITHDRAWAL', snapshot);
  if (pending.length === 1) {
    if (!key && positiveInt(pending[0]?.meta?.amountVnd) === amountVnd) return { ok: true, replay: pending[0], snapshot };
    return refusal(409, 'PENDING_WITHDRAWAL', snapshot);
  }

  if (!(Number(vndPerUsd) > 0)) return refusal(503, 'EXCHANGE_RATE_UNAVAILABLE', snapshot);
  if (!account) return refusal(400, 'BANK_ACCOUNT_REQUIRED', snapshot);
  if (!holderMatchesKyc(account.accountName, user?.kyc)) return refusal(400, 'ACCOUNT_NAME_MISMATCH', snapshot);
  if (amountVnd > snapshot.payableVnd) return refusal(400, snapshot.payableVnd > 0 ? 'DEPOSIT_CAP' : zeroReason(snapshot), snapshot);
  const conv = convertAmount({ amount: amountVnd, currency: 'VND' }, vndPerUsd);
  if (!conv || usdExceedsPayable(conv.amountUsd, snapshot)) return refusal(400, 'DEPOSIT_CAP', snapshot);

  return {
    ok: true,
    snapshot,
    draft: {
      amountUsd: conv.amountUsd,
      amountVnd: conv.amountVnd,
      idempotencyKey: key,
      account: {
        bankName: account.bankName,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        source: account.source || 'saved',
      },
      fx,
      payableVnd: snapshot.payableVnd,
      payableUsd: snapshot.payableUsd,
    },
  };
}

function usdExceedsPayable(amountUsd, snapshot) {
  return centsOf(amountUsd) > centsOf(snapshot.payableUsd);
}

/**
 * Reserve the wallet row before the payout record. If the payout record fails,
 * cancel the reservation. Linking a created payout must not drop the reservation.
 */
async function commitBuyerVietqrDraft(draft, io) {
  const tx = await io.createTx(draft);
  let payout;
  try {
    payout = await io.createPayout(draft, tx);
  } catch (err) {
    await io.cancelTx(tx);
    throw err;
  }
  try {
    const linked = await io.linkPayout(tx, payout);
    return { tx: linked || tx, payout };
  } catch {
    return { tx, payout, linkPending: true };
  }
}

module.exports = {
  SOURCE,
  MESSAGES,
  classifyDeposit,
  isBuyerDepositWithdrawal,
  isVietqrDepositWithdrawalRequest,
  buyerVietqrWithdrawActivated,
  buyerVietqrSnapshot,
  publicBuyerDepositWithdraw,
  decideBuyerVietqrWithdrawal,
  commitBuyerVietqrDraft,
  cleanIdempotencyKey,
  maxVndFunded,
};
