const express = require('express');
const multer = require('multer');
const User = require('../models/User');
const { authenticate, requireRoles, invalidateAuthUserCache } = require('../middleware/auth');
const {
  isMinioEnabled,
  uploadKycBuffer,
  isKycObjectForUser,
  getKycPresignedUrl,
  getKycObjectStream,
} = require('../config/minio');
const {
  KYC_SIDES,
  mapKyc,
  kycOf,
  kycStatus,
  canSubmit,
  objectNameForSide,
} = require('../utils/kyc');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Only jpeg, png, webp images are allowed for eKYC'));
  },
});

function ensureKyc(user) {
  if (!user.kyc) user.kyc = {};
  return user.kyc;
}

/** GET /v1/kyc/me */
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(mapKyc(user, { includeSensitive: true }));
  } catch (err) {
    next(err);
  }
});

/** POST /v1/kyc/documents/:side — upload front|back|selfie → private MinIO */
router.post('/documents/:side', authenticate, upload.single('image'), async (req, res, next) => {
  try {
    const side = String(req.params.side || '').trim();
    if (!KYC_SIDES.includes(side)) {
      return res.status(400).json({ message: 'side must be front, back, or selfie', code: 'INVALID_SIDE' });
    }
    if (!isMinioEnabled()) {
      return res.status(503).json({ message: 'Document upload is not configured (MinIO)', code: 'MINIO_NOT_CONFIGURED' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No image file uploaded', code: 'NO_FILE' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const status = kycStatus(user);
    if (status === 'pending' || status === 'verified') {
      return res.status(400).json({
        message: status === 'verified' ? 'Identity already verified' : 'KYC is under review; wait for a decision',
        code: 'KYC_LOCKED',
        kycStatus: status,
      });
    }

    const uploaded = await uploadKycBuffer(req.file.buffer, {
      userId: user._id,
      side,
      contentType: req.file.mimetype,
      filename: req.file.originalname,
    });

    const kyc = ensureKyc(user);
    kyc[`${side}ObjectName`] = uploaded.objectName;
    if (status === 'none' || status === 'rejected') {
      kyc.status = 'draft';
      if (status === 'rejected') {
        kyc.rejectReason = '';
        kyc.reviewedAt = null;
        kyc.reviewedBy = null;
      }
    }
    user.markModified('kyc');
    await user.save();
    await invalidateAuthUserCache(user._id);

    let previewUrl = '';
    try {
      previewUrl = await getKycPresignedUrl(uploaded.objectName, 900);
    } catch {
      /* optional */
    }

    res.status(201).json({
      ok: true,
      side,
      objectName: uploaded.objectName,
      previewUrl,
      kyc: mapKyc(user, { includeSensitive: true }),
    });
  } catch (e) {
    if (e instanceof multer.MulterError && e.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'Image must be 8MB or smaller', code: 'FILE_TOO_LARGE' });
    }
    next(e);
  }
});

/** GET /v1/kyc/documents/:side — short-lived preview URL (owner or admin) */
router.get('/documents/:side', authenticate, async (req, res, next) => {
  try {
    const side = String(req.params.side || '').trim();
    if (!KYC_SIDES.includes(side)) {
      return res.status(400).json({ message: 'side must be front, back, or selfie', code: 'INVALID_SIDE' });
    }
    const targetId = req.query.userId && req.user.role === 'admin' ? String(req.query.userId) : String(req.user._id);
    const user = await User.findById(targetId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (String(user._id) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' });
    }
    const objectName = objectNameForSide(kycOf(user), side);
    if (!objectName) return res.status(404).json({ message: 'Document not uploaded', code: 'NO_DOCUMENT' });
    if (!isKycObjectForUser(objectName, user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' });
    }
    if (!isMinioEnabled()) {
      return res.status(503).json({ message: 'MinIO is not configured', code: 'MINIO_NOT_CONFIGURED' });
    }
    const url = await getKycPresignedUrl(objectName, 900);
    res.json({ side, url, expiresIn: 900 });
  } catch (err) {
    next(err);
  }
});

/** GET /v1/kyc/documents/:side/stream — auth stream (owner/admin) */
router.get('/documents/:side/stream', authenticate, async (req, res, next) => {
  try {
    const side = String(req.params.side || '').trim();
    if (!KYC_SIDES.includes(side)) {
      return res.status(400).json({ message: 'Invalid side', code: 'INVALID_SIDE' });
    }
    const targetId = req.query.userId && req.user.role === 'admin' ? String(req.query.userId) : String(req.user._id);
    const user = await User.findById(targetId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (String(user._id) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' });
    }
    const objectName = objectNameForSide(kycOf(user), side);
    if (!objectName) return res.status(404).json({ message: 'Document not uploaded', code: 'NO_DOCUMENT' });
    const stream = await getKycObjectStream(objectName);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'image/jpeg');
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

/** POST /v1/kyc/submit */
router.post('/submit', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const status = kycStatus(user);
    if (status === 'verified') {
      return res.status(400).json({ message: 'Already verified', code: 'KYC_VERIFIED' });
    }
    if (status === 'pending') {
      return res.status(400).json({ message: 'Already submitted; awaiting review', code: 'KYC_PENDING' });
    }

    const fullName = String(req.body?.fullName || user.name || '').trim().slice(0, 200);
    const idType = String(req.body?.idType || 'cccd').trim();
    const idNumber = String(req.body?.idNumber || '')
      .trim()
      .replace(/\s+/g, '')
      .slice(0, 64);
    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ message: 'Full legal name is required', code: 'NAME_REQUIRED' });
    }
    if (!User.KYC_ID_TYPES.includes(idType)) {
      return res.status(400).json({ message: 'Invalid idType', code: 'INVALID_ID_TYPE' });
    }
    if (idNumber.length < 6) {
      return res.status(400).json({ message: 'ID number is required (min 6 characters)', code: 'ID_REQUIRED' });
    }

    const kyc = ensureKyc(user);
    kyc.fullName = fullName;
    kyc.idType = idType;
    kyc.idNumber = idNumber;
    if (!canSubmit(kyc, status)) {
      return res.status(400).json({
        message: 'Upload front, back, and selfie photos before submitting',
        code: 'DOCUMENTS_INCOMPLETE',
      });
    }
    kyc.status = 'pending';
    kyc.submittedAt = new Date();
    kyc.rejectReason = '';
    user.markModified('kyc');
    await user.save();
    await invalidateAuthUserCache(user._id);

    res.json({ ok: true, kyc: mapKyc(user, { includeSensitive: true }) });
  } catch (err) {
    next(err);
  }
});

/** GET /v1/kyc/admin/queue */
router.get('/admin/queue', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const status = String(req.query.status || 'pending').trim();
    const filter = status === 'all' ? { 'kyc.status': { $in: ['pending', 'verified', 'rejected'] } } : { 'kyc.status': status };
    const users = await User.find(filter).sort({ 'kyc.submittedAt': -1 }).limit(100).lean();
    res.json(
      users.map((u) => ({
        userId: String(u._id),
        email: u.email,
        name: u.name,
        role: u.role,
        kyc: mapKyc(u, { includeSensitive: true }),
      })),
    );
  } catch (err) {
    next(err);
  }
});

/** PATCH /v1/kyc/admin/:userId — { decision: 'verified'|'rejected', rejectReason? } */
router.patch('/admin/:userId', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const decision = String(req.body?.decision || '').trim();
    if (decision !== 'verified' && decision !== 'rejected') {
      return res.status(400).json({ message: 'decision must be verified or rejected', code: 'INVALID_DECISION' });
    }
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const kyc = ensureKyc(user);
    if (kycStatus(user) !== 'pending' && decision === 'verified') {
      // allow force-verify from draft for ops
    }
    kyc.status = decision;
    kyc.reviewedAt = new Date();
    kyc.reviewedBy = req.user._id;
    kyc.rejectReason = decision === 'rejected' ? String(req.body?.rejectReason || '').trim().slice(0, 1000) : '';
    user.markModified('kyc');
    await user.save();
    await invalidateAuthUserCache(user._id);
    res.json({ ok: true, userId: String(user._id), kyc: mapKyc(user, { includeSensitive: true }) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
