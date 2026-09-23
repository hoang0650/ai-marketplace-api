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
    res.json({
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

/** SePay / bank-transfer top-up is retired. Web uses PayPal; mobile uses IAP. */
router.post('/deposit', authenticate, (_req, res) => {
  res.status(410).json({
    code: 'SEPAY_DISABLED',
    message:
      'Bank transfer top-up is no longer available. Use PayPal on the website, or in-app purchase in the iOS/Android app.',
  });
});

router.post('/withdraw', authenticate, async (req, res, next) => {
  try {
    const amount = normalizeAmount(req.body?.amount);
    if (amount === null) {
      return res.status(400).json({ message: `Invalid amount (0 < amount <= ${MAX_TX_AMOUNT})` });
    }

    const { personas, persona, policy } = await resolvePayoutPersona(req.user, req.body?.persona);

    // Buyers have a spend-only wallet — no cash-out.
    if (!policy.canWithdraw) {
      return res.status(403).json({
        message: 'Buyer wallets cannot be withdrawn. Seller/talent/employer earnings only.',
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

    // Employer / HR minimum balance (VND threshold, quoted in USD for the ledger).
    const minAmount = Number(policy.minAmount || 0);
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

    const { available, held, balance } = await getAvailableBalance(req.user._id);
    if (amount > available) {
      return res.status(400).json({
        message: `Insufficient available balance. Ledger ${balance.toFixed(2)}, held ${held.toFixed(2)} (48h protection or open dispute on those orders only), available ${available.toFixed(2)}.`,
        code: 'PAYOUT_HELD',
        balance,
        held,
        available,
      });
    }

    // Seller-like personas additionally need a VERIFIED seller profile.
    if (persona !== 'employer' && req.user.role !== 'admin') {
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

    const quote = quoteWithdrawal(amount, policy);
    const { createPayout } = require('../finance/payout-engine');
    const { payout } = await createPayout({
      sellerId: req.user._id,
      payableAmount: quote.net,
      taxAmount: quote.tax,
      commissionAmount: quote.platformFee,
      currency: 'USD',
      actorId: req.user._id,
      idempotencyKey: `wd_${req.user._id}_${amount}_${Date.now()}`,
    });
    if (payout.status === 'ON_HOLD' && req.user.role !== 'admin' && persona !== 'employer') {
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
