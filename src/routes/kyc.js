const express = require('express');
const multer = require('multer');
const User = require('../models/User');
const { notifyUser } = require('../utils/notify');
const { authenticate, requireRoles, invalidateAuthUserCache } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/audit');
const {
  isMinioEnabled,
  uploadKycBuffer,
  isKycObjectForUser,
  getKycPresignedUrl,
  getKycObjectStream,
  statKycObject,
} = require('../config/minio');
const {
  KYC_DOC_SIDES,
  LICENSE_SIDE,
  mapKyc,
  kycOf,
  kycStatus,
  canSubmit,
  objectNameForSide,
  parseKycSubmission,
  licenseFileOf,
  ensureKycRecordId,
  newKycRecordId,
  kycDocumentsOf,
} = require('../utils/kyc');
const { UPLOAD_MAX_BYTES, isAllowedUploadMime, validateKycDocument } = require('../utils/kyc-upload');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (isAllowedUploadMime(file.mimetype)) cb(null, true);
    else {
      const err = new Error('ID photos must be jpeg/png/webp; the business licence must be a PDF');
      err.status = 400;
      err.code = 'INVALID_FILE_TYPE';
      cb(err);
    }
  },
});

/** Accept the file under "file" (preferred) or the legacy "image" field. */
const uploadFields = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'image', maxCount: 1 },
]);
/** Multer errors happen before the handler, so map them to clean 4xx responses here. */
function uploadOne(req, res, next) {
  uploadFields(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File must be 10MB or smaller', code: 'FILE_TOO_LARGE' });
    }
    if (err instanceof multer.MulterError) return res.status(400).json({ message: err.message, code: err.code });
    if (err.code === 'INVALID_FILE_TYPE') return res.status(400).json({ message: err.message, code: err.code });
    return next(err);
  });
}
function pickFile(req) {
  return req.files?.file?.[0] || req.files?.image?.[0] || null;
}

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

/** POST /v1/kyc/documents/:side — upload ID front|back or business licence → private MinIO */
router.post('/documents/:side', authenticate, uploadOne, async (req, res, next) => {
  try {
    const side = String(req.params.side || '').trim();
    if (!KYC_DOC_SIDES.includes(side)) {
      return res.status(400).json({ message: 'side must be front, back or license', code: 'INVALID_SIDE' });
    }
    if (!isMinioEnabled()) {
      return res.status(503).json({ message: 'Document upload is not configured (MinIO)', code: 'MINIO_NOT_CONFIGURED' });
    }
    const file = pickFile(req);
    const check = validateKycDocument(side, file);
    if (!check.ok) return res.status(check.status).json({ message: check.message, code: check.code });

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

    const uploaded = await uploadKycBuffer(file.buffer, {
      userId: user._id,
      side,
      contentType: check.contentType,
      filename: file.originalname,
    });

    const kyc = ensureKyc(user);
    ensureKycRecordId(kyc);
    kyc[`${side}ObjectName`] = uploaded.objectName;
    kyc[`${side}FileName`] = String(file.originalname || `${side}`).slice(0, 255);
    kyc[`${side}FileSize`] = file.size || file.buffer.length;
    kyc[`${side}ContentType`] = check.contentType;
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
      return res.status(413).json({ message: 'File must be 10MB or smaller', code: 'FILE_TOO_LARGE' });
    }
    if (e && e.code === 'INVALID_FILE_TYPE') return res.status(400).json({ message: e.message, code: e.code });
    next(e);
  }
});

/** GET /v1/kyc/documents/:side — short-lived preview URL (owner or admin) */
router.get('/documents/:side', authenticate, async (req, res, next) => {
  try {
    const side = String(req.params.side || '').trim();
    if (!KYC_DOC_SIDES.includes(side)) {
      return res.status(400).json({ message: 'side must be front, back or license', code: 'INVALID_SIDE' });
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
    const meta = side === LICENSE_SIDE ? licenseFileOf(kycOf(user)) : null;
    res.json({ side, url, expiresIn: 900, ...(meta ? { file: meta } : {}) });
  } catch (err) {
    next(err);
  }
});

/** GET /v1/kyc/documents/:side/stream — auth stream (owner/admin) */
router.get('/documents/:side/stream', authenticate, async (req, res, next) => {
  try {
    const side = String(req.params.side || '').trim();
    if (!KYC_DOC_SIDES.includes(side)) {
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
    const meta = side === LICENSE_SIDE ? licenseFileOf(kycOf(user)) : null;
    res.setHeader('Content-Type', meta ? meta.contentType : 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
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

    const parsed = parseKycSubmission(req.body, user.name);
    if (!parsed.ok) return res.status(400).json({ message: parsed.message, code: parsed.code });

    const kyc = ensureKyc(user);
    if (!canSubmit(kyc, status, parsed.data.subjectType)) {
      const needsLicense = parsed.data.subjectType === 'organization';
      return res.status(400).json({
        message: needsLicense
          ? 'Upload the front and back of the representative ID and the business registration certificate before submitting'
          : 'Upload the front and back of the ID document before submitting',
        code: needsLicense && !String(kyc[`${LICENSE_SIDE}ObjectName`] || '').trim() ? 'BUSINESS_LICENSE_REQUIRED' : 'DOCUMENTS_INCOMPLETE',
      });
    }
    Object.assign(kyc, parsed.data);
    ensureKycRecordId(kyc);
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

const REVIEW_STATUSES = ['pending', 'verified', 'rejected'];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** GET /v1/kyc/admin/queue?status=pending|verified|rejected|all&subjectType=&q= */
router.get('/admin/queue', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const status = String(req.query.status || 'pending').trim();
    const filter = {
      'kyc.status': status === 'all' || !REVIEW_STATUSES.includes(status) ? { $in: REVIEW_STATUSES } : status,
    };
    const subjectType = String(req.query.subjectType || '').trim();
    if (subjectType === 'organization') filter['kyc.subjectType'] = 'organization';
    else if (subjectType === 'individual') filter['kyc.subjectType'] = { $ne: 'organization' };
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) {
      const re = new RegExp(escapeRegex(q), 'i');
      // A pasted MinIO key like aimarkets/kyc/<userId>/front-… also finds the user by id.
      const idInQ = (q.match(/\b[a-f0-9]{24}\b/i) || [])[0];
      filter.$or = [
        ...(idInQ ? [{ _id: idInQ.toLowerCase() }] : []),
        { 'kyc.recordId': re },
        { 'kyc.frontObjectName': re },
        { 'kyc.backObjectName': re },
        { 'kyc.licenseObjectName': re },
        { email: re },
        { name: re },
        { 'kyc.fullName': re },
        { 'kyc.orgName': re },
        { 'kyc.orgTaxCode': re },
        { 'kyc.personalTaxCode': re },
        { 'kyc.idNumber': re },
      ];
    }

    const [users, counts] = await Promise.all([
      User.find(filter)
        .sort({ 'kyc.submittedAt': status === 'pending' ? 1 : -1 })
        .limit(200)
        .populate('kyc.reviewedBy', 'name email')
        .lean(),
      User.aggregate([
        { $match: { 'kyc.status': { $in: REVIEW_STATUSES } } },
        { $group: { _id: '$kyc.status', n: { $sum: 1 } } },
      ]),
    ]);
    const countBy = Object.fromEntries(counts.map((c) => [c._id, c.n]));
    // Backfill a record id for older KYC records so admins can reference them.
    const missing = users.filter((u) => u.kyc && !u.kyc.recordId);
    if (missing.length) {
      for (const u of missing) u.kyc.recordId = newKycRecordId();
      await User.bulkWrite(
        missing.map((u) => ({
          updateOne: {
            filter: { _id: u._id, $or: [{ 'kyc.recordId': '' }, { 'kyc.recordId': { $exists: false } }] },
            update: { $set: { 'kyc.recordId': u.kyc.recordId } },
          },
        })),
      );
    }

    res.json({
      counts: { pending: countBy.pending || 0, verified: countBy.verified || 0, rejected: countBy.rejected || 0 },
      items: users.map((u) => {
        const reviewer = u.kyc?.reviewedBy && typeof u.kyc.reviewedBy === 'object' ? u.kyc.reviewedBy : null;
        return {
          userId: String(u._id),
          email: u.email,
          name: u.name,
          role: u.role,
          reviewedBy: reviewer ? { name: reviewer.name || '', email: reviewer.email || '' } : null,
          kyc: mapKyc(u, { includeSensitive: true, includeObjectKeys: true }),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/** GET /v1/kyc/admin/:userId/documents — admin only: MinIO keys + file name/size (size from MinIO when not recorded). */
router.get('/admin/:userId/documents', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const user = await User.findById(String(req.params.userId)).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    const k = kycOf(user);
    const documents = kycDocumentsOf(k);
    if (isMinioEnabled()) {
      await Promise.all(
        documents.map(async (d) => {
          try {
            const st = await statKycObject(d.objectKey);
            d.exists = Boolean(st);
            if (st && !d.size) d.size = st.size;
            if (st && st.contentType && !k[`${d.side}ContentType`]) d.contentType = st.contentType;
          } catch {
            d.exists = null;
          }
        }),
      );
    }
    res.json({ userId: String(user._id), recordId: k.recordId || '', prefix: `kyc/${user._id}/`, documents });
  } catch (err) {
    next(err);
  }
});

/** PATCH /v1/kyc/admin/:userId — { decision: 'verified'|'rejected', rejectReason (required when rejected) } */
router.patch('/admin/:userId', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const decision = String(req.body?.decision || '').trim();
    if (decision !== 'verified' && decision !== 'rejected') {
      return res.status(400).json({ message: 'decision must be verified or rejected', code: 'INVALID_DECISION' });
    }
    const rejectReason = String(req.body?.rejectReason || '').trim().slice(0, 1000);
    if (decision === 'rejected' && rejectReason.length < 5) {
      return res.status(400).json({ message: 'A reject reason is required so the user can fix the application', code: 'REASON_REQUIRED' });
    }
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const before = kycStatus(user);
    if (before !== 'pending') {
      return res.status(409).json({ message: 'Only pending applications can be reviewed', code: 'KYC_NOT_PENDING', kycStatus: before });
    }

    const kyc = ensureKyc(user);
    kyc.status = decision;
    kyc.reviewedAt = new Date();
    kyc.reviewedBy = req.user._id;
    kyc.rejectReason = decision === 'rejected' ? rejectReason : '';
    user.markModified('kyc');
    await user.save();
    await invalidateAuthUserCache(user._id);

    await notifyUser(
      user._id,
      decision === 'verified' ? 'kyc.verified' : 'kyc.rejected',
      decision === 'verified' ? {} : { reason: rejectReason },
      '/settings/kyc',
    );
    await writeAuditLog({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: decision === 'verified' ? 'KYC_VERIFIED' : 'KYC_REJECTED',
      resourceType: 'User',
      resourceId: user._id,
      oldValue: { kycStatus: before },
      newValue: { kycStatus: decision, subjectType: kyc.subjectType || 'individual' },
      reason: kyc.rejectReason,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });

    res.json({ ok: true, userId: String(user._id), kyc: mapKyc(user, { includeSensitive: true, includeObjectKeys: true }) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
