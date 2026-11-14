const express = require('express');
const WalletTx = require('../models/WalletTx');
const { authenticate } = require('../middleware/auth');
const { mapWallet } = require('../utils/mappers');

const { MAX_TX_AMOUNT, normalizeAmount, getBalance, getAvailableBalance } = require('../utils/wallet');
const {
  detectPersonas,
  resolvePayoutPersona,
  quoteWithdrawal,
  mapPolicy,
  pickPrimary,
  SELLER_LIKE,
} = require('../finance/payout-policy');
const { isVietqrDepositWithdrawalRequest } = require('../finance/buyer-deposit-withdraw');

const router = express.Router();

/**
 * Affiliate commission shares the ledger as a payout liability. It is excluded from the
 * spendable balance used for purchases, and it cannot be converted into internal balance.
 * The only withdrawal is a bank payout to the affiliate's own registered account
 * (no commercial minimum, configured PIT rate, paid within 7 working days after the 48h hold).
 */
async function affiliateSlice(userId) {
  const { getAffiliateBalance } = require('../finance/affiliate-service');
  return getAffiliateBalance(userId).catch(() => ({ earned: 0, held: 0, withdrawn: 0, balance: 0, available: 0 }));
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const txs = await WalletTx.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
    const { quoteAuthoritativeVnd, currentFx } = require('../finance/vnd-quote');
    const fx = await currentFx();
    res.json(txs.map((tx) => {
      const row = mapWallet(tx);
      return {
        ...row,
        displayVnd: quoteAuthoritativeVnd({
          amount: row.amount,
          currency: row.currency || 'USD',
          vndPerUsd: fx.vndPerUsd,
          rateSource: fx.rateSource,
        }),
      };
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/summary', authenticate, async (req, res, next) => {
  try {
    const summary = await getAvailableBalance(req.user._id);
    const { personas, persona, policy } = await resolvePayoutPersona(req.user, req.query.persona);
    let affiliate = null;
    let affiliateAvailable = 0;
    if (personas.includes('affiliate') || persona === 'affiliate') {
      const { affiliateConfig } = require('../config/affiliate');
      const { affiliateCanWithdraw } = require('../finance/affiliate-engine');
      const cfg = affiliateConfig();
      const slice = await affiliateSlice(req.user._id);
      affiliateAvailable = slice.available;
      const identityVerified = req.user?.role === 'admin' || (req.user?.kyc?.status || req.user?.kycStatus) === 'verified';
      affiliate = {
        ...slice,
        minWithdrawVnd: 0,
        availableVnd: cfg.pit.vndPerUsd > 0 ? Math.round(slice.available * cfg.pit.vndPerUsd) : null,
        canWithdraw: affiliateCanWithdraw({ available: slice.available, identityVerified }),
      };
    }
    const { summaryPayable, loadSellerEarnedAvailable } = require('../finance/withdrawable-balance');
    const payoutPool = summary.payoutAvailable ?? summary.available;
    const poolForPersona = persona === 'affiliate'
      ? payoutPool
      : Math.max(0, Math.round((payoutPool - affiliateAvailable) * 100) / 100);
    const earned = persona === 'buyer' || persona === 'affiliate'
      ? { available: 0 }
      : await loadSellerEarnedAvailable(req.user._id);
    const payable = summaryPayable({
      persona,
      poolAvailable: poolForPersona,
      earnedAvailable: earned.available,
      affiliateAvailable,
      walletBalance: summary.balance,
    });
    res.json({
      affiliate,
      currency: 'USD',
      holdHours: require('../utils/payout-hold').HOLD_HOURS,
      ...summary,
      persona,
      personas,
      policy: mapPolicy(policy),
      payableAmount: payable.payableAmount,
      payableCode: payable.payableCode,
      buyerIdentityRequired: false,
      buyerCashoutAllowed: false,
      prepaidWithdrawable: false,
      buyerDepositWithdraw: await buyerDepositWithdrawFor(req.user._id, req.user),
      displayVnd: await (async () => {
        const { quoteAuthoritativeVnd, currentFx } = require('../finance/vnd-quote');
        const fx = await currentFx();
        const one = (amount) => quoteAuthoritativeVnd({ amount, currency: 'USD', vndPerUsd: fx.vndPerUsd, rateSource: fx.rateSource });
        if (affiliate) affiliate.displayVnd = one(affiliate.available);
        return {
          ledgerCurrency: 'USD',
          clientRateIgnored: true,
          balance: one(summary.balance),
          available: one(summary.available),
          payable: one(payable.payableAmount),
        };
      })(),
    });
  } catch (err) {
    next(err);
  }
});

/** Fee/tax/min policy per persona — also drives the withdraw screens. */
router.get('/payout-policy', authenticate, async (req, res, next) => {
  try {
    const { personas, persona, policy } = await resolvePayoutPersona(req.user, req.query.persona);
    const amount = req.query.amount !== undefined ? Number(req.query.amount) : null;
    res.json({
      persona,
      personas,
      policy: mapPolicy(policy),
      quote: Number.isFinite(amount) && amount > 0 ? quoteWithdrawal(amount, policy) : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * SePay top-up is retired. Web tops up via GPay (ATM / card / VietQR) when GPAY_ENABLED=true;
 * mobile tops up via Apple IAP / Google Play Billing. These rails only fund the wallet —
 * orders are paid exclusively from the AI Markets wallet balance.
 */
router.post('/deposit', authenticate, (_req, res) => {
  res.status(410).json({
    code: 'SEPAY_DISABLED',
    message: 'This top-up endpoint is no longer available. Top up with VietQR to the company bank account from the wallet page. In-app purchase is a separate channel.',
  });
});

const {
  parseBankAccount,
  holderMatchesKyc,
  hasPayoutAccount,
  mapPayoutAccount,
} = require('../utils/payout-account');

/**
 * Validate a payout account for the user: explicit body account (optionally saved), else the saved one.
 * @returns {Promise<{ok:true, account:object} | {ok:false, code:string, message:string}>}
 */
async function resolveWithdrawAccount(userId, rawAccount, { save = false } = {}) {
  const User = require('../models/User');
  const user = await User.findById(userId).select('kyc payoutAccount');
  if (!user) return { ok: false, code: 'NOT_FOUND', message: 'User not found' };
  if (!rawAccount) {
    if (hasPayoutAccount(user.payoutAccount)) {
      const a = user.payoutAccount;
      return { ok: true, account: { bankName: a.bankName, accountNumber: a.accountNumber, accountName: a.accountName, source: 'saved' } };
    }
    return { ok: false, code: 'BANK_ACCOUNT_REQUIRED', message: 'Bank name, account number and account holder are required' };
  }
  const parsed = parseBankAccount(rawAccount);
  if (!parsed.ok) return parsed;
  if (!holderMatchesKyc(parsed.data.accountName, user.kyc)) {
    return {
      ok: false,
      code: 'ACCOUNT_NAME_MISMATCH',
      message: 'The account holder name must match your verified eKYC name',
    };
  }
  if (save) {
    user.payoutAccount = { ...parsed.data, updatedAt: new Date() };
    await user.save();
  }
  return { ok: true, account: { ...parsed.data, source: 'request' } };
}

/** GET /v1/wallet/payout-account — own saved payout account + whether eKYC allows editing it. */
router.get('/payout-account', authenticate, async (req, res, next) => {
  try {
    const User = require('../models/User');
    const { kycStatus } = require('../utils/kyc');
    const user = await User.findById(req.user._id).select('role kyc payoutAccount').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    const status = kycStatus(user);
    res.json({
      account: mapPayoutAccount(user.payoutAccount),
      kycStatus: status,
      canEdit: status === 'verified' || user.role === 'admin',
      holderName: (user.kyc?.subjectType === 'organization' ? user.kyc?.orgName : user.kyc?.fullName) || user.kyc?.fullName || '',
    });
  } catch (err) {
    next(err);
  }
});

/** PUT /v1/wallet/payout-account — save own payout account (eKYC verified; holder must match the eKYC name). */
router.put('/payout-account', authenticate, async (req, res, next) => {
  try {
    const User = require('../models/User');
    const { assertCanWithdrawKyc } = require('../utils/kyc');
    const user = await User.findById(req.user._id).select('role kyc payoutAccount');
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role !== 'admin') {
      const gate = assertCanWithdrawKyc(user);
      if (!gate.ok) return res.status(403).json({ message: gate.message, code: gate.code || 'KYC_REQUIRED', kycStatus: gate.kycStatus });
    }
    const parsed = parseBankAccount(req.body);
    if (!parsed.ok) return res.status(400).json({ message: parsed.message, code: parsed.code });
    if (!holderMatchesKyc(parsed.data.accountName, user.kyc)) {
      return res.status(400).json({ message: 'The account holder name must match your verified eKYC name', code: 'ACCOUNT_NAME_MISMATCH' });
    }
    user.payoutAccount = { ...parsed.data, updatedAt: new Date() };
    await user.save();
    res.json({ ok: true, account: mapPayoutAccount(user.payoutAccount) });
  } catch (err) {
    next(err);
  }
});

router.post('/withdraw', authenticate, async (req, res, next) => {
  try {
    if (isVietqrDepositWithdrawalRequest(req.body)) {
      return withdrawVietqrCompanyBank(req, res, next);
    }
    await require('../finance/exchange-rate').getExchangeRates();
    const { personas, persona, policy } = await resolvePayoutPersona(req.user, req.body?.persona);
    if (policy.minAmountVnd > 0 && !(Number(policy.minAmount) > 0)) {
      return res.status(503).json({
        message: 'Exchange rate is unavailable. Conversion waits for a rate from ExchangeRate-API (https://www.exchangerate-api.com).',
        code: 'EXCHANGE_RATE_UNAVAILABLE',
      });
    }

    // Affiliate amounts are checked by quoteAffiliateWithdrawal (precision, not a commercial minimum).
    // Other personas keep the shared USD normalizer, including seller and employer minimums below.
    let amount = null;
    if (persona !== 'affiliate') {
      amount = normalizeAmount(req.body?.amount);
      if (amount === null) {
        return res.status(400).json({ message: `Invalid amount (0 < amount <= ${MAX_TX_AMOUNT})` });
      }
    }

    if (!policy.canWithdraw) {
      return res.status(403).json({
        message:
          persona === 'buyer'
            ? require('../finance/withdrawable-balance').BUYER_MESSAGE
            : 'Withdrawal is not available for this account.',
        code: policy.unavailableCode || 'WITHDRAW_UNAVAILABLE',
        persona: pickPrimary(personas),
        personas,
        policy: mapPolicy(policy),
      });
    }

    // eKYC — every non-admin persona must be verified.
    if (req.user.role !== 'admin') {
      const { assertCanWithdrawKyc } = require('../utils/kyc');
      const User = require('../models/User');
      const fresh = await User.findById(req.user._id).select('role kyc');
      const kycGate = assertCanWithdrawKyc(fresh || req.user);
      if (!kycGate.ok) {
        return res.status(403).json({
          message: kycGate.message,
          code: kycGate.code || 'KYC_REQUIRED',
          kycStatus: kycGate.kycStatus,
        });
      }
    }

    // Seller payouts may name a bank account that matches eKYC. Affiliate commission
    // can be paid only to the account already registered on that affiliate.
    const {
      decideAffiliateWithdrawal,
      forbiddenCommissionUse,
      COMMISSION_BANK_ONLY_MESSAGE,
      COMMISSION_BANK_ONLY_CODE,
    } = require('../finance/affiliate-use-policy');
    if (persona === 'affiliate' && forbiddenCommissionUse(req.body)) {
      return res.status(403).json({
        message: COMMISSION_BANK_ONLY_MESSAGE,
        code: COMMISSION_BANK_ONLY_CODE,
        persona,
      });
    }
    let payoutAccount = null;
    if (persona !== 'affiliate' && req.body?.bankAccount) {
      const resolved = await resolveWithdrawAccount(req.user._id, req.body?.bankAccount, {
        save: req.body?.saveAccount === true,
      });
      if (!resolved.ok) {
        if (req.body?.bankAccount) {
          return res.status(400).json({ message: resolved.message, code: resolved.code });
        }
      } else payoutAccount = resolved.account;
    }

    // One lock covers the earnings read and the withdraw insert. A second request
    // waits until the pending withdraw is stored, so the same earnings are not paid twice.
    const { withWalletLock } = require('../utils/wallet-lock');
    const settled = await withWalletLock(req.user._id, async () => {
      // Affiliate persona: no commercial minimum. USD with 2 decimals; sub-cent amounts are precision.
      // PIT uses the configured rate unless an approved Mẫu 08/CK-TNCN applies.
      // The payout account is the one registered to this affiliate, not a free-typed account.
      let affiliateQuote = null;
      let payAmount = amount;
      if (persona === 'affiliate') {
        const User = require('../models/User');
        const { quoteAffiliateWithdrawal } = require('../finance/affiliate-engine');
        const lockedUser = await User.findById(req.user._id).select('kyc payoutAccount role');
        const slice = await affiliateSlice(req.user._id);
        const overall = await getAvailableBalance(req.user._id);
        const payoutPool = overall.payoutAvailable ?? overall.available;
        const bank = decideAffiliateWithdrawal({
          body: req.body,
          registered: lockedUser?.payoutAccount,
          payoutPool,
          affiliateAvailable: slice.available,
        });
        if (!bank.ok) {
          return { status: bank.status, body: { message: bank.message, code: bank.code, persona } };
        }
        if (req.user.role !== 'admin' && !holderMatchesKyc(bank.account.accountName, lockedUser?.kyc)) {
          return {
            status: 400,
            body: {
              message: 'The account holder name must match your verified eKYC name',
              code: 'ACCOUNT_NAME_MISMATCH',
              persona,
            },
          };
        }
        payoutAccount = bank.account;
        affiliateQuote = quoteAffiliateWithdrawal({
          amount: req.body?.amount,
          available: Math.min(slice.available, payoutPool),
          currency: 'USD',
          digits: 2,
          pitCommitmentApproved: !!policy.pitCommitmentApproved,
        });
        if (!affiliateQuote.ok) {
          return {
            status: 400,
            body: {
              message: affiliateQuote.message,
              code: affiliateQuote.code,
              persona,
              minAmountVnd: 0,
              amountVnd: affiliateQuote.amountVnd,
              availableVnd: affiliateQuote.availableVnd,
              available: affiliateQuote.available,
            },
          };
        }
        payAmount = affiliateQuote.gross;
        if (!(payAmount > 0) || payAmount > MAX_TX_AMOUNT) {
          return { status: 400, body: { message: `Invalid amount (0 < amount <= ${MAX_TX_AMOUNT})` } };
        }
      }

      // Employer / HR minimum balance (VND threshold, quoted in USD for the ledger).
      const minAmount = persona === 'affiliate' ? 0 : Number(policy.minAmount || 0);
      if (minAmount > 0) {
        const { balance } = await getAvailableBalance(req.user._id);
        if (balance < minAmount) {
          return {
            status: 403,
            body: {
              message: `Minimum balance ${policy.minAmountVnd.toLocaleString('vi-VN')} VND (~$${minAmount.toFixed(2)}) required to withdraw.`,
              code: 'MIN_BALANCE_REQUIRED',
              persona,
              minAmount,
              minAmountVnd: policy.minAmountVnd,
              minAmountCurrency: policy.minAmountCurrency,
              balance,
            },
          };
        }
      }

      const summaryNow = await getAvailableBalance(req.user._id);
      const { held, balance } = summaryNow;
      const payoutPool = summaryNow.payoutAvailable ?? summaryNow.available;
      let available = payoutPool;
      if (persona !== 'affiliate') {
        // Reserve the affiliate slice: it can only leave through the affiliate persona (PIT applies).
        // Seller net snapshots are already net of affiliate commission, so this does not subtract those earnings again.
        const slice = await affiliateSlice(req.user._id);
        available = Math.max(0, Math.round((payoutPool - slice.available) * 100) / 100);
      }
      if (persona !== 'affiliate') {
        const { payoutCap, loadSellerEarnedAvailable, PREPAID_MESSAGE } = require('../finance/withdrawable-balance');
        const earned = await loadSellerEarnedAvailable(req.user._id);
        const cap = payoutCap({ persona, amount: payAmount, poolAvailable: available, earnedAvailable: earned.available });
        if (!cap.ok && cap.code === 'PREPAID_NOT_WITHDRAWABLE') {
          return {
            status: 403,
            body: {
              message: cap.message || PREPAID_MESSAGE,
              code: 'PREPAID_NOT_WITHDRAWABLE',
              persona,
              payable: cap.payable,
              balance,
              held,
              available,
            },
          };
        }
        if (!cap.ok && cap.code === 'PAYOUT_HELD') {
          return {
            status: 400,
            body: {
              message: `Insufficient available balance. Ledger ${balance.toFixed(2)}, held ${held.toFixed(2)} (48h protection or open dispute on those orders only), available ${available.toFixed(2)}.`,
              code: 'PAYOUT_HELD',
              payable: cap.payable,
              balance,
              held,
              available,
            },
          };
        }
      } else if (payAmount > available) {
        return {
          status: 400,
          body: {
            message: `Insufficient available balance. Ledger ${balance.toFixed(2)}, held ${held.toFixed(2)} (48h protection or open dispute on those orders only), available ${available.toFixed(2)}.`,
            code: 'PAYOUT_HELD',
            balance,
            held,
            available,
          },
        };
      }

      // Seller-like personas additionally need a VERIFIED seller profile. Buyer persona cannot cash out.
      const needsSellerProfile = persona !== 'employer' && persona !== 'buyer' && persona !== 'affiliate' && req.user.role !== 'admin';
      if (needsSellerProfile) {
        const SellerProfile = require('../models/SellerProfile');
        const profile = await SellerProfile.findOne({ user: req.user._id }).lean();
        const { canPayoutSeller } = require('../finance/payout-engine');
        const gate = canPayoutSeller(profile);
        if (!gate.ok) {
          return {
            status: 403,
            body: {
              message: 'Payout on hold until seller verification/compliance is complete.',
              code: gate.holdReason || 'PAYOUT_ON_HOLD',
            },
          };
        }
      }

      const quote = affiliateQuote
        ? { gross: affiliateQuote.gross, platformFee: 0, tax: affiliateQuote.pitAmount, net: affiliateQuote.net, totalFee: affiliateQuote.pitAmount, chargeAtWithdraw: true }
        : quoteWithdrawal(payAmount, policy);
      const { createPayout } = require('../finance/payout-engine');
      const { getExchangeRates, fxAudit } = require('../finance/exchange-rate');
      const fx = await getExchangeRates();
      const { payout } = await createPayout({
        sellerId: req.user._id,
        payableAmount: quote.net,
        taxAmount: quote.tax,
        commissionAmount: quote.platformFee,
        currency: 'USD',
        actorId: req.user._id,
        idempotencyKey: `wd_${req.user._id}_${payAmount}_${Date.now()}`,
        requireSellerProfile: persona !== 'buyer' && persona !== 'affiliate',
      });
      if (payout.status === 'ON_HOLD' && needsSellerProfile) {
        return {
          status: 403,
          body: {
            message: payout.holdReason || 'Payout on hold',
            code: payout.holdReason,
            payoutId: payout.payoutId,
          },
        };
      }

      const tx = await WalletTx.create({
        user: req.user._id,
        type: 'withdraw',
        amount: quote.gross,
        currency: 'USD',
        status: 'pending',
        payoutId: payout.payoutId,
        note: `Payout ${payout.payoutId} · ${persona} · gross ${quote.gross} − fee ${quote.platformFee} − tax ${quote.tax} = net ${quote.net}`,
        meta: {
          ...fxAudit(fx),
          channel: 'payout',
          persona,
          ...(persona === 'affiliate' ? require('../finance/payout-due').affiliatePayoutDueMetadata({ requestedAt: new Date() }) : {}),
          ...(SELLER_LIKE.has(persona) ? require('../finance/payout-due').sellerPayoutDueMetadata({ requestedAt: new Date() }) : {}),
          grossAmount: quote.gross,
          platformFeeRate: policy.platformFeeRate,
          platformFee: quote.platformFee,
          taxRate: policy.taxRate,
          tax: quote.tax,
          netAmount: quote.net,
          ...(payoutAccount ? { payoutAccount } : {}),
          ...(affiliateQuote
            ? {
                pitRule: affiliateQuote.pitRule,
                pitRate: affiliateQuote.pitRate,
                pitAmount: affiliateQuote.pitAmount,
                amountVnd: affiliateQuote.amountVnd,
                pitAmountVnd: affiliateQuote.pitAmountVnd,
                pitCommitmentApplied: affiliateQuote.pitCommitmentApplied,
              }
            : {}),
        },
      });
      return { status: 201, tx, payout, quote };
    });
    if (settled.status !== 201) return res.status(settled.status).json(settled.body);
    res.status(201).json({
      ...mapWallet(settled.tx),
      payoutId: settled.payout.payoutId,
      quote: settled.quote,
      policy: mapPolicy(policy),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Seller ledger (Sổ cái): the authenticated user's own sales, usage revenue, fees, tax withheld,
 * affiliate commission, refunds/clawbacks, withdrawals and adjustments - from stored snapshots.
 * Query: from, to (YYYY-MM-DD), type (comma list). Running balance is computed over the full
 * history before filtering, so filtered rows still show the true balance at that point.
 */
router.get('/seller-ledger', authenticate, async (req, res, next) => {
  try {
    const Order = require('../models/Order');
    const UsageEvent = require('../models/UsageEvent');
    const { buildSellerLedger, filterEntries } = require('../finance/seller-ledger');
    const me = req.user._id;
    const [orders, usage, txs, balance] = await Promise.all([
      Order.find({ seller: me, status: { $in: ['paid', 'refunded', 'completed'] } })
        .select('amount grossAmount currency commissionRate commissionAmount taxAmount taxPolicy storeFeeAmount paymentFeeAmount affiliateRate affiliateCommissionAmount sellerNetAmount sellerNet platformFee financialSnapshot ownershipType status disputeStatus payoutHoldUntil completedAt createdAt productName contractSnapshot.productName')
        .sort({ createdAt: -1 })
        .limit(5000)
        .lean(),
      UsageEvent.find({ seller: me, sellerNet: { $gt: 0 } })
        .select('product cost platformFee sellerNet currency createdAt')
        .sort({ createdAt: -1 })
        .limit(20000)
        .lean(),
      WalletTx.find({ user: me, type: { $in: ['withdraw', 'debit', 'credit'] } })
        .select('type amount currency note status payoutId reviewedBy createdAt')
        .sort({ createdAt: -1 })
        .limit(10000)
        .lean(),
      getAvailableBalance(me),
    ]);
    const ledger = buildSellerLedger({ orders, usage, txs, balance });
    const entries = filterEntries(ledger.entries, req.query || {});
    res.json({
      summary: ledger.summary,
      types: ledger.types,
      holdHours: require('../utils/payout-hold').HOLD_HOURS,
      total: entries.length,
      entries: entries.slice(0, 2000).map(({ counts, ...e }) => ({ ...e, counted: counts })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Separated VietQR company-bank view. Missing affiliate evidence fails closed.
 * payableUsd is an FX reference and is not a second balance the client may submit.
 */
async function buyerDepositWithdrawFor(userId, user) {
  const { buyerVietqrSnapshot, publicBuyerDepositWithdraw, buyerVietqrWithdrawActivated } = require('../finance/buyer-deposit-withdraw');
  const { kycStatus } = require('../utils/kyc');
  const { getAffiliateBalance } = require('../finance/affiliate-service');
  const { getExchangeRates } = require('../finance/exchange-rate');
  const summary = await getAvailableBalance(userId);
  let poolKnown = true;
  let affiliateAvailable = 0;
  try {
    affiliateAvailable = Number((await getAffiliateBalance(userId)).available) || 0;
  } catch {
    poolKnown = false;
  }
  const payoutPool = summary.payoutAvailable ?? summary.available;
  const pool = poolKnown ? Math.max(0, Math.round((payoutPool - affiliateAvailable) * 100) / 100) : 0;
  const rows = await WalletTx.find({ user: userId, type: { $in: ['deposit', 'debit', 'withdraw', 'credit'] } })
    .select('type amount status paymentMethod createdAt meta')
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  let rate = 0;
  try {
    rate = Number((await getExchangeRates())?.vndPerUsd) || 0;
  } catch {
    rate = 0;
  }
  const snap = buyerVietqrSnapshot(rows, pool, rate);
  return publicBuyerDepositWithdraw(snap, {
    electronicIdentityStatus: kycStatus(user),
    poolKnown,
    activated: buyerVietqrWithdrawActivated(),
  });
}

function vietqrResponseBody(tx, payout, replay) {
  const raw = typeof tx.toObject === 'function' ? tx.toObject() : tx;
  return {
    ...mapWallet(tx),
    payoutId: payout?.payoutId || raw.payoutId || '',
    payoutStatus: payout?.status || '',
    settlement: 'VND',
    amountVnd: Number.isInteger(raw.meta?.amountVnd) ? raw.meta.amountVnd : null,
    transferExecuted: false,
    idempotentReplay: replay === true,
  };
}

/**
 * VietQR company-bank deposit withdrawal. Runs before the persona USD path, so a buyer
 * request without `source` stays rejected. Electronic identity is user.kyc.status only.
 * The payout row is a request record; it does not send a bank transfer.
 */
async function withdrawVietqrCompanyBank(req, res, next) {
  try {
    const User = require('../models/User');
    const { withWalletLock } = require('../utils/wallet-lock');
    const { getAffiliateBalance } = require('../finance/affiliate-service');
    const { getExchangeRates, fxAudit } = require('../finance/exchange-rate');
    const { createPayout } = require('../finance/payout-engine');
    const {
      SOURCE,
      MESSAGES,
      decideBuyerVietqrWithdrawal,
      commitBuyerVietqrDraft,
      buyerVietqrWithdrawActivated,
    } = require('../finance/buyer-deposit-withdraw');
    const activated = buyerVietqrWithdrawActivated();
    if (req.body?.settlement != null && String(req.body.settlement) !== 'VND') {
      return res.status(400).json({ message: 'This withdrawal settles in VND.', code: 'INVALID_AMOUNT' });
    }
    const amountVnd = Number(req.body?.amountVnd);
    const idempotencyKey = req.get('Idempotency-Key') || req.body?.idempotencyKey;

    const settled = await withWalletLock(req.user._id, async () => {
      const lockedUser = await User.findById(req.user._id).select('role kyc payoutAccount');
      if (!lockedUser) return { status: 404, body: { message: 'User not found' } };
      const resolved = await resolveWithdrawAccount(req.user._id, req.body?.bankAccount, {
        save: req.body?.saveAccount === true,
      });
      const account = resolved.ok ? resolved.account : null;
      const summaryNow = await getAvailableBalance(req.user._id);
      let poolKnown = true;
      let affiliateAvailable = 0;
      try {
        affiliateAvailable = Number((await getAffiliateBalance(req.user._id)).available) || 0;
      } catch {
        poolKnown = false;
      }
      const payoutPoolNow = summaryNow.payoutAvailable ?? summaryNow.available;
      const pool = poolKnown
        ? Math.max(0, Math.round((payoutPoolNow - affiliateAvailable) * 100) / 100)
        : 0;
      const rows = await WalletTx.find({
        user: req.user._id,
        type: { $in: ['deposit', 'debit', 'withdraw', 'credit'] },
      })
        .select('type amount status paymentMethod createdAt payoutId meta')
        .sort({ createdAt: 1, _id: 1 })
        .lean();
      let fx = null;
      try {
        fx = await getExchangeRates();
      } catch {
        fx = null;
      }
      const decision = decideBuyerVietqrWithdrawal({
        user: lockedUser,
        amountVnd,
        idempotencyKey,
        account,
        rows,
        poolAvailableUsd: pool,
        vndPerUsd: Number(fx?.vndPerUsd) || 0,
        fx: fx ? fxAudit(fx) : {},
        activated,
      });
      if (!decision.ok) {
        if (!resolved.ok && (decision.code === 'BANK_ACCOUNT_REQUIRED' || decision.code === 'ACCOUNT_NAME_MISMATCH')) {
          return {
            status: 400,
            body: {
              message: resolved.message,
              code: resolved.code,
              payableVnd: decision.payableVnd,
              payableUsd: decision.payableUsd,
              blockedSources: decision.blockedSources,
            },
          };
        }
        return {
          status: decision.status,
          body: {
            message: decision.message,
            code: decision.code,
            payableVnd: decision.payableVnd,
            payableUsd: decision.payableUsd,
            blockedSources: decision.blockedSources,
            ...(decision.electronicIdentityStatus ? { kycStatus: decision.electronicIdentityStatus, electronicIdentityStatus: decision.electronicIdentityStatus } : {}),
          },
        };
      }
      if (!poolKnown && decision.draft) {
        return {
          status: 400,
          body: {
            message: MESSAGES.SOURCE_NOT_SEPARATED,
            code: 'SOURCE_NOT_SEPARATED',
            payableVnd: 0,
            payableUsd: 0,
            blockedSources: ['unknown'],
          },
        };
      }
      const recordPayout = (draft, tx) => createPayout({
        sellerId: req.user._id,
        payableAmount: draft?.amountUsd ?? tx.amount,
        currency: 'USD',
        actorId: req.user._id,
        idempotencyKey: `vietqr:${req.user._id}:${tx._id}`,
        requireSellerProfile: false,
        extraMeta: {
          ...(draft?.fx || {}),
          source: SOURCE,
          persona: 'buyer',
          settlement: 'VND',
          amountVnd: draft?.amountVnd ?? tx.meta?.amountVnd,
          transferExecuted: false,
        },
      }).then((result) => result.payout);

      if (decision.replay) {
        const full = await WalletTx.findById(decision.replay._id);
        if (!full) {
          return { status: 409, body: { message: MESSAGES.PENDING_WITHDRAWAL, code: 'PENDING_WITHDRAWAL', payableVnd: 0, payableUsd: 0, blockedSources: [] } };
        }
        let payout = null;
        if (!full.payoutId) {
          payout = await recordPayout(decision.draft, full);
          full.payoutId = payout.payoutId;
          await full.save();
        }
        return { status: 200, body: vietqrResponseBody(full, payout, true) };
      }

      const saved = await commitBuyerVietqrDraft(decision.draft, {
        createTx: (draft) => WalletTx.create({
          user: req.user._id,
          type: 'withdraw',
          amount: draft.amountUsd,
          currency: 'USD',
          status: 'pending',
          note: `VietQR company-bank withdrawal request ${draft.amountVnd} VND`,
          meta: {
            ...draft.fx,
            channel: 'payout',
            persona: 'buyer',
            source: SOURCE,
            settlement: 'VND',
            amountVnd: draft.amountVnd,
            grossAmount: draft.amountUsd,
            netAmount: draft.amountUsd,
            payoutAccount: draft.account,
            refundsSeparate: true,
            idempotencyKey: draft.idempotencyKey || '',
            transferExecuted: false,
          },
        }),
        createPayout: recordPayout,
        linkPayout: async (tx, payout) => {
          tx.payoutId = payout.payoutId;
          await tx.save();
          return tx;
        },
        cancelTx: (tx) => WalletTx.updateOne(
          { _id: tx._id, status: 'pending' },
          { $set: { status: 'cancelled', note: 'VietQR withdrawal cancelled before the payout record was stored' } },
        ),
      });
      return { status: 201, body: vietqrResponseBody(saved.tx, saved.payout, false) };
    });
    res.status(settled.status).json(settled.body);
  } catch (err) {
    next(err);
  }
}

module.exports = router;
