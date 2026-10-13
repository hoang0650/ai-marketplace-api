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
} = require('../finance/payout-policy');

const router = express.Router();

/**
 * Affiliate commissions sit in the same wallet but are withdrawn only under the affiliate persona
 * (min 2,000,000 VND, 10% PIT). Other personas cannot spend that slice on withdrawal.
 */
async function affiliateSlice(userId) {
  const { getAffiliateBalance } = require('../finance/affiliate-service');
  return getAffiliateBalance(userId).catch(() => ({ earned: 0, held: 0, withdrawn: 0, balance: 0, available: 0 }));
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const txs = await WalletTx.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json(txs.map(mapWallet));
  } catch (err) {
    next(err);
  }
});

router.get('/summary', authenticate, async (req, res, next) => {
  try {
    const summary = await getAvailableBalance(req.user._id);
    const { personas, persona, policy } = await resolvePayoutPersona(req.user, req.query.persona);
    let affiliate = null;
    if (personas.includes('affiliate')) {
      const { affiliateConfig } = require('../config/affiliate');
      const cfg = affiliateConfig();
      const slice = await affiliateSlice(req.user._id);
      affiliate = {
        ...slice,
        minWithdrawVnd: cfg.pit.minWithdrawVnd,
        availableVnd: Math.round(slice.available * cfg.pit.vndPerUsd),
        canWithdraw: slice.available * cfg.pit.vndPerUsd >= cfg.pit.minWithdrawVnd,
      };
    }
    res.json({
      affiliate,
      currency: 'USD',
      holdHours: require('../utils/payout-hold').HOLD_HOURS,
      ...summary,
      persona,
      personas,
      policy: mapPolicy(policy),
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
 * SePay / bank-transfer top-up is retired. Web tops up via GPay (ATM / card / VietQR);
 * mobile tops up via Apple IAP / Google Play Billing. These rails only fund the wallet —
 * orders are paid exclusively from the AI Markets wallet balance.
 */
router.post('/deposit', authenticate, (_req, res) => {
  res.status(410).json({
    code: 'SEPAY_DISABLED',
    message:
      'Bank transfer top-up is no longer available. Top up with GPay (ATM / card / VietQR) on the website, or in-app purchase in the iOS/Android app.',
  });
});

router.post('/withdraw', authenticate, async (req, res, next) => {
  try {
    const amount = normalizeAmount(req.body?.amount);
    if (amount === null) {
      return res.status(400).json({ message: `Invalid amount (0 < amount <= ${MAX_TX_AMOUNT})` });
    }

    const { personas, persona, policy } = await resolvePayoutPersona(req.user, req.body?.persona);

    if (!policy.canWithdraw) {
      return res.status(403).json({
        message: 'Withdrawal is not available for this account.',
        code: 'WITHDRAW_UNAVAILABLE',
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

    // Buyers have no seller payout account on file: the bank account comes with the request.
    let payoutAccount = null;
    if (persona === 'buyer' || req.body?.bankAccount) {
      const { parseBankAccount } = require('../utils/payout-account');
      const parsedAccount = parseBankAccount(req.body?.bankAccount);
      if (!parsedAccount.ok) {
        if (persona === 'buyer') {
          return res.status(400).json({ message: parsedAccount.message, code: parsedAccount.code });
        }
      } else payoutAccount = parsedAccount.data;
    }

    // Affiliate persona: min balance + min withdrawal 2,000,000 VND, 10% PIT per withdrawal.
    let affiliateQuote = null;
    if (persona === 'affiliate') {
      const { quoteAffiliateWithdrawal } = require('../finance/affiliate-engine');
      const slice = await affiliateSlice(req.user._id);
      const overall = await getAvailableBalance(req.user._id);
      affiliateQuote = quoteAffiliateWithdrawal({
        amount,
        available: Math.min(slice.available, overall.available),
        currency: 'USD',
        pitCommitmentApproved: !!policy.pitCommitmentApproved,
      });
      if (!affiliateQuote.ok) {
        return res.status(affiliateQuote.code === 'AFFILIATE_INSUFFICIENT' ? 400 : 403).json({
          message: affiliateQuote.message,
          code: affiliateQuote.code,
          persona,
          minAmountVnd: affiliateQuote.minWithdrawVnd,
          amountVnd: affiliateQuote.amountVnd,
          availableVnd: affiliateQuote.availableVnd,
          available: affiliateQuote.available,
        });
      }
    }

    // Employer / HR minimum balance (VND threshold, quoted in USD for the ledger).
    const minAmount = persona === 'affiliate' ? 0 : Number(policy.minAmount || 0);
    if (minAmount > 0) {
      const { balance } = await getAvailableBalance(req.user._id);
      if (balance < minAmount) {
        return res.status(403).json({
          message: `Minimum balance ${policy.minAmountVnd.toLocaleString('vi-VN')} VND (~$${minAmount.toFixed(2)}) required to withdraw.`,
          code: 'MIN_BALANCE_REQUIRED',
          persona,
          minAmount,
          minAmountVnd: policy.minAmountVnd,
          minAmountCurrency: policy.minAmountCurrency,
          balance,
        });
      }
    }

    const summaryNow = await getAvailableBalance(req.user._id);
    const { held, balance } = summaryNow;
    let available = summaryNow.available;
    if (persona !== 'affiliate' && req.user.role !== 'admin') {
      // Reserve the affiliate slice: it can only leave through the affiliate persona (PIT applies).
      const slice = await affiliateSlice(req.user._id);
      available = Math.max(0, Math.round((available - slice.available) * 100) / 100);
    }
    if (amount > available) {
      return res.status(400).json({
        message: `Insufficient available balance. Ledger ${balance.toFixed(2)}, held ${held.toFixed(2)} (48h protection or open dispute on those orders only), available ${available.toFixed(2)}.`,
        code: 'PAYOUT_HELD',
        balance,
        held,
        available,
      });
    }

    // Seller-like personas additionally need a VERIFIED seller profile (buyers only need eKYC).
    const needsSellerProfile = persona !== 'employer' && persona !== 'buyer' && persona !== 'affiliate' && req.user.role !== 'admin';
    if (needsSellerProfile) {
      const SellerProfile = require('../models/SellerProfile');
      const profile = await SellerProfile.findOne({ user: req.user._id }).lean();
      const { canPayoutSeller } = require('../finance/payout-engine');
      const gate = canPayoutSeller(profile);
      if (!gate.ok) {
        return res.status(403).json({
          message: 'Payout on hold until seller verification/compliance is complete.',
          code: gate.holdReason || 'PAYOUT_ON_HOLD',
        });
      }
    }

    const quote = affiliateQuote
      ? { gross: affiliateQuote.gross, platformFee: 0, tax: affiliateQuote.pitAmount, net: affiliateQuote.net, totalFee: affiliateQuote.pitAmount, chargeAtWithdraw: true }
      : quoteWithdrawal(amount, policy);
    const { createPayout } = require('../finance/payout-engine');
    const { payout } = await createPayout({
      sellerId: req.user._id,
      payableAmount: quote.net,
      taxAmount: quote.tax,
      commissionAmount: quote.platformFee,
      currency: 'USD',
      actorId: req.user._id,
      idempotencyKey: `wd_${req.user._id}_${amount}_${Date.now()}`,
      requireSellerProfile: persona !== 'buyer' && persona !== 'affiliate',
    });
    if (payout.status === 'ON_HOLD' && needsSellerProfile) {
      return res.status(403).json({
        message: payout.holdReason || 'Payout on hold',
        code: payout.holdReason,
        payoutId: payout.payoutId,
      });
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
        channel: 'payout',
        persona,
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
    res.status(201).json({
      ...mapWallet(tx),
      payoutId: payout.payoutId,
      quote,
      policy: mapPolicy(policy),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
