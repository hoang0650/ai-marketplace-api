const express = require('express');
const SellerProfile = require('../models/SellerProfile');
const LegalDocument = require('../models/LegalDocument');
const LegalAcceptance = require('../models/LegalAcceptance');
const { authenticate, requireRoles } = require('../middleware/auth');
const { getOrCreateSellerProfile } = require('../utils/seller-compliance');
const { writeAuditLog } = require('../utils/audit');
const { PLATFORM_COMMISSION_RATE, SELLER_TAX_RATE } = require('../finance/constants');

const router = express.Router();

function mapSellerProfile(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  return {
    id: String(o._id || o.id),
    userId: String(o.user?._id || o.user),
    sellerType: o.sellerType,
    legalName: o.legalName || '',
    displayName: o.displayName || '',
    taxCode: o.taxCode || '',
    businessRegistrationNumber: o.businessRegistrationNumber || '',
    businessAddress: o.businessAddress || '',
    contactEmail: o.contactEmail || '',
    contactPhone: o.contactPhone || '',
    identityVerificationStatus: o.identityVerificationStatus || 'none',
    bankAccountMetadata: o.bankAccountMetadata || {},
    verificationStatus: o.verificationStatus,
    complianceStatus: o.complianceStatus,
    sellerAgreementVersion: o.sellerAgreementVersion || '',
    sellerAgreementAcceptedAt: o.sellerAgreementAcceptedAt
      ? new Date(o.sellerAgreementAcceptedAt).toISOString()
      : null,
    verifiedAt: o.verifiedAt ? new Date(o.verifiedAt).toISOString() : null,
    rejectedAt: o.rejectedAt ? new Date(o.rejectedAt).toISOString() : null,
    suspendedAt: o.suspendedAt ? new Date(o.suspendedAt).toISOString() : null,
    statusReason: o.statusReason || '',
    canPublish: o.verificationStatus === 'VERIFIED' && !!o.sellerAgreementAcceptedAt,
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : null,
    updatedAt: o.updatedAt ? new Date(o.updatedAt).toISOString() : null,
  };
}

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const profile = await SellerProfile.findOne({ user: req.user._id });
    if (!profile) return res.json(null);
    res.json(mapSellerProfile(profile));
  } catch (err) {
    next(err);
  }
});

/** Start / update seller application (third-party sellers only). */
router.post('/apply', authenticate, async (req, res, next) => {
  try {
    const body = req.body || {};
    const profile = await getOrCreateSellerProfile(req.user, {
      displayName: body.displayName,
      legalName: body.legalName,
      contactEmail: body.contactEmail,
    });

    const fields = [
      'sellerType',
      'legalName',
      'displayName',
      'taxCode',
      'businessRegistrationNumber',
      'businessAddress',
      'contactEmail',
      'contactPhone',
    ];
    for (const key of fields) {
      if (body[key] !== undefined) profile[key] = body[key];
    }
    if (body.bankAccountMetadata && typeof body.bankAccountMetadata === 'object') {
      profile.bankAccountMetadata = {
        bankName: String(body.bankAccountMetadata.bankName || '').slice(0, 120),
        accountHolderName: String(body.bankAccountMetadata.accountHolderName || '').slice(0, 120),
        accountNumberMasked: String(body.bankAccountMetadata.accountNumberMasked || '').slice(0, 40),
      };
    }

    if (profile.verificationStatus === 'PENDING') {
      profile.verificationStatus = 'VERIFICATION_REQUIRED';
    }
    profile.identityVerificationStatus = 'pending';
    profile.complianceStatus = 'under_review';
    await profile.save();

    await writeAuditLog({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: 'SELLER_APPLY',
      resourceType: 'SellerProfile',
      resourceId: profile._id,
      newValue: { verificationStatus: profile.verificationStatus },
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json(mapSellerProfile(profile));
  } catch (err) {
    next(err);
  }
});

/** Accept current seller agreement (clickwrap). */
router.post('/accept-agreement', authenticate, async (req, res, next) => {
  try {
    const doc = await LegalDocument.findOne({
      documentType: 'seller-agreement',
      status: 'published',
      locale: 'vi',
    }).sort({ effectiveAt: -1 });

    if (!doc) {
      return res.status(404).json({ message: 'Seller agreement not published yet' });
    }

    const profile = await getOrCreateSellerProfile(req.user);
    profile.sellerAgreementVersion = doc.version;
    profile.sellerAgreementAcceptedAt = new Date();
    await profile.save();

    await LegalAcceptance.findOneAndUpdate(
      {
        user: req.user._id,
        documentType: 'seller-agreement',
        version: doc.version,
      },
      {
        $set: {
          documentId: doc._id,
          acceptedAt: new Date(),
          ip: req.ip || '',
          userAgent: req.get('user-agent') || '',
          context: 'seller_onboarding',
        },
      },
      { upsert: true },
    );

    await writeAuditLog({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: 'SELLER_AGREEMENT_ACCEPT',
      resourceType: 'LegalDocument',
      resourceId: doc._id,
      newValue: { version: doc.version },
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json(mapSellerProfile(profile));
  } catch (err) {
    next(err);
  }
});

/** Admin: list seller applications. */
router.get('/', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const filter = status ? { verificationStatus: status } : {};
    const rows = await SellerProfile.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
    res.json(rows.map(mapSellerProfile));
  } catch (err) {
    next(err);
  }
});

/** Admin: verify / reject / suspend seller. */
router.patch('/:id/status', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const profile = await SellerProfile.findById(req.params.id);
    if (!profile) return res.status(404).json({ message: 'Seller profile not found' });

    const status = String(req.body?.status || '');
    const allowed = ['VERIFIED', 'REJECTED', 'SUSPENDED', 'TERMINATED', 'VERIFICATION_REQUIRED'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: `status must be one of ${allowed.join(', ')}` });
    }

    const old = profile.verificationStatus;
    profile.verificationStatus = status;
    profile.statusReason = String(req.body?.reason || '').slice(0, 1000);
    profile.reviewedBy = req.user._id;
    profile.reviewedAt = new Date();
    if (status === 'VERIFIED') {
      profile.verifiedAt = new Date();
      profile.complianceStatus = 'compliant';
      profile.identityVerificationStatus = 'verified';
      profile.rejectedAt = null;
      profile.suspendedAt = null;
    } else if (status === 'REJECTED') {
      profile.rejectedAt = new Date();
      profile.complianceStatus = 'non_compliant';
      profile.identityVerificationStatus = 'rejected';
    } else if (status === 'SUSPENDED' || status === 'TERMINATED') {
      profile.suspendedAt = new Date();
      profile.complianceStatus = 'non_compliant';
    }
    await profile.save();

    await writeAuditLog({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: 'SELLER_STATUS_CHANGE',
      resourceType: 'SellerProfile',
      resourceId: profile._id,
      oldValue: { verificationStatus: old },
      newValue: { verificationStatus: status },
      reason: profile.statusReason,
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json(mapSellerProfile(profile));
  } catch (err) {
    next(err);
  }
});

router.get('/me/earnings', authenticate, async (req, res, next) => {
  try {
    const paid = await Order.find({ seller: req.user._id, status: { $in: ['paid', 'refunded'] } }).lean();
    const grossSales = paid.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    const platformFee = paid.reduce(
      (s, o) => s + (Number(o.commissionAmount ?? (o.ownershipType === 'PLATFORM_DIRECT' ? 0 : o.platformFee)) || 0),
      0,
    );
    const taxWithholding = paid.reduce((s, o) => s + (Number(o.taxAmount) || 0), 0);
    const paymentFees = paid.reduce((s, o) => s + (Number(o.paymentFeeAmount) || 0), 0);
    const storeFees = paid.reduce((s, o) => s + (Number(o.storeFeeAmount) || 0), 0);
    const refunds = paid.reduce((s, o) => s + (Number(o.refundAmount) || 0), 0);
    const chargebacks = paid.reduce((s, o) => s + (Number(o.chargebackAmount) || 0), 0);
    const netPayable = paid.reduce((s, o) => s + (Number(o.sellerNetAmount ?? o.sellerNet) || 0), 0);
    res.json({
      grossSales,
      platformFee,
      platformCommissionRate: PLATFORM_COMMISSION_RATE,
      sellerTaxRate: SELLER_TAX_RATE,
      taxWithholding,
      paymentFees,
      storeFees,
      refunds,
      chargebacks,
      netPayable,
      currency: paid[0]?.currency || 'USD',
      orderCount: paid.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me/payouts', authenticate, async (req, res, next) => {
  try {
    const SellerPayout = require('../models/SellerPayout');
    const rows = await SellerPayout.find({ sellerId: req.user._id }).sort({ createdAt: -1 }).limit(100).lean();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/me/tax-profile', authenticate, async (req, res, next) => {
  try {
    const { currentSellerTaxProfile } = require('../finance/settlement-service');
    const profile = await currentSellerTaxProfile(req.user._id);
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

router.post('/me/tax-profile', authenticate, async (req, res, next) => {
  try {
    const SellerTaxProfile = require('../models/SellerTaxProfile');
    const { normalizeSellerType } = require('../finance/seller-types');
    const { writeAuditLog } = require('../utils/audit');
    const current = await SellerTaxProfile.findOne({ sellerId: req.user._id, effectiveTo: null }).sort({ version: -1 });
    const nextVersion = (current?.version || 0) + 1;
    if (current) {
      current.effectiveTo = new Date();
      await current.save();
    }
    const created = await SellerTaxProfile.create({
      sellerId: req.user._id,
      sellerType: normalizeSellerType(req.body?.sellerType || current?.sellerType),
      country: String(req.body?.country || current?.country || 'VN').toUpperCase().slice(0, 8),
      taxResidency: String(req.body?.taxResidency || req.body?.country || current?.taxResidency || 'VN')
        .toUpperCase()
        .slice(0, 8),
      taxIdentificationNumber: String(req.body?.taxIdentificationNumber || req.body?.taxCode || '').slice(0, 50),
      businessRegistrationNumber: String(req.body?.businessRegistrationNumber || '').slice(0, 100),
      vatStatus: String(req.body?.vatStatus || '').slice(0, 80),
      taxMethod: String(req.body?.taxMethod || '').slice(0, 80),
      invoiceMethod: String(req.body?.invoiceMethod || '').slice(0, 80),
      withholdingRequired: !!req.body?.withholdingRequired,
      taxClassification: String(req.body?.taxClassification || '').slice(0, 80),
      effectiveFrom: new Date(),
      effectiveTo: null,
      verificationStatus: 'PENDING',
      version: nextVersion,
    });
    await writeAuditLog({
      actorId: req.user._id,
      action: 'SELLER_TAX_PROFILE_CHANGED',
      resourceType: 'SellerTaxProfile',
      resourceId: created._id,
      oldValue: current ? { version: current.version } : null,
      newValue: { version: created.version, sellerType: created.sellerType },
      ip: req.ip,
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
