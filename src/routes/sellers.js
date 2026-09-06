const express = require('express');
const SellerProfile = require('../models/SellerProfile');
const LegalDocument = require('../models/LegalDocument');
const LegalAcceptance = require('../models/LegalAcceptance');
const { authenticate, requireRoles } = require('../middleware/auth');
const { getOrCreateSellerProfile } = require('../utils/seller-compliance');
const { writeAuditLog } = require('../utils/audit');

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

module.exports = router;
