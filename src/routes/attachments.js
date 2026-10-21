const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const Attachment = require('../models/Attachment');
const Conversation = require('../models/Conversation');
const HireProject = require('../models/HireProject');
const Complaint = require('../models/Complaint');
const { authenticate } = require('../middleware/auth');
const { isMinioEnabled, putAttachmentObject, getAttachmentStream } = require('../config/minio');
const { MAX_BYTES, inspectFile, verifySig, publicAttachment } = require('../utils/attachments');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
const isId = (v) => mongoose.isValidObjectId(v);
const fail = (res, status, code, message) => res.status(status).json({ code, error: code, message: message || code });

/** Participant check for a scope. Admins may read (complaints) but not upload. */
async function canAccess(scope, scopeId, user, { write = false } = {}) {
  if (!isId(scopeId)) return false;
  const me = String(user._id);
  let doc = null;
  if (scope === 'chat') doc = await Conversation.findById(scopeId).select('buyer seller').lean();
  else if (scope === 'hire') doc = await HireProject.findById(scopeId).select('buyer seller status').lean();
  else if (scope === 'complaint') {
    const c = await Complaint.findById(scopeId).select('complainant seller status').lean();
    if (!c) return false;
    if ([String(c.complainant), String(c.seller || '')].includes(me)) return !write || c.status !== 'closed';
    // Admins handle complaints, so they may also attach files to the case thread.
    return user.role === 'admin' && (!write || c.status !== 'closed');
  }
  if (!doc) return false;
  if ([String(doc.buyer), String(doc.seller)].includes(me)) return true;
  return !write && user.role === 'admin';
}

/** POST /v1/attachments (multipart: file, scope=chat|hire, scopeId) → attachment with signed URL. */
router.post('/', authenticate, (req, res, next) => {
  upload.single('file')(req, res, async (e) => {
    try {
      if (e instanceof multer.MulterError && e.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'FILE_TOO_LARGE', 'Max 25MB per file');
      if (e) return fail(res, 400, 'UPLOAD_INVALID', e.message);
      if (!isMinioEnabled()) return fail(res, 503, 'MINIO_NOT_CONFIGURED');
      const scope = String(req.body?.scope || '');
      const scopeId = String(req.body?.scopeId || '');
      if (!['chat', 'hire', 'complaint'].includes(scope)) return fail(res, 400, 'SCOPE_INVALID');
      if (!(await canAccess(scope, scopeId, req.user, { write: true }))) return fail(res, 403, 'ATTACHMENT_FORBIDDEN');
      if (!req.file) return fail(res, 400, 'NO_FILE');
      const recent = await Attachment.countDocuments({ owner: req.user._id, createdAt: { $gte: new Date(Date.now() - 3600e3) } });
      if (recent >= 60) return fail(res, 429, 'ATTACHMENT_RATE_LIMIT');
      const info = inspectFile(req.file.buffer, Buffer.from(req.file.originalname || '', 'latin1').toString('utf8'));
      const objectName = await putAttachmentObject(scope, scopeId, info.ext, req.file.buffer, info.mime);
      const doc = await Attachment.create({
        owner: req.user._id,
        scope,
        scopeId,
        objectName,
        name: info.name,
        mime: info.mime,
        size: req.file.size,
        kind: info.kind,
      });
      res.status(201).json(publicAttachment(doc, attachmentBase(req)));
    } catch (err) {
      if (err.code && err.status) return fail(res, err.status, err.code);
      next(err);
    }
  });
});

/** GET /v1/attachments/:id/raw?exp&sig[&dl=1] — signed link, minted only for participants. */
router.get('/:id/raw', async (req, res, next) => {
  try {
    if (!isId(req.params.id) || !verifySig(req.params.id, req.query.exp, req.query.sig)) return fail(res, 403, 'LINK_INVALID');
    const a = await Attachment.findById(req.params.id).lean();
    if (!a) return fail(res, 404, 'ATTACHMENT_NOT_FOUND');
    const inline = a.kind === 'image' && req.query.dl !== '1';
    const fname = encodeURIComponent(a.name);
    res.set({
      'Content-Type': inline ? a.mime : 'application/octet-stream',
      'Content-Length': String(a.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${fname}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=3600',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    const stream = await getAttachmentStream(a.objectName);
    stream.on('error', next).pipe(res);
  } catch (err) {
    next(err);
  }
});

function defaultBase() {
  const { apiPublicUrl } = require('../config/env');
  return (apiPublicUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

function attachmentBase(req) {
  const { apiPublicUrl } = require('../config/env');
  if (apiPublicUrl) return apiPublicUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * Resolve client-sent attachment ids for a message: must belong to the sender and the same scope.
 * Returns embedded metadata ({ attachment, name, mime, size, kind }).
 */
async function resolveAttachments(ids, { scope, scopeId, owner }) {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
  if (!list.length) return [];
  const { MAX_PER_MESSAGE } = require('../utils/attachments');
  if (list.length > MAX_PER_MESSAGE || !list.every(isId)) throw Object.assign(new Error('ATTACHMENTS_INVALID'), { status: 400, code: 'ATTACHMENTS_INVALID' });
  const docs = await Attachment.find({ _id: { $in: list }, owner, scope, scopeId }).lean();
  if (docs.length !== list.length) throw Object.assign(new Error('ATTACHMENTS_INVALID'), { status: 400, code: 'ATTACHMENTS_INVALID' });
  return list.map((id) => docs.find((d) => String(d._id) === id)).map((d) => ({ attachment: d._id, name: d.name, mime: d.mime, size: d.size, kind: d.kind }));
}

/** Embedded attachment metadata → client shape with fresh signed URLs. */
function mapEmbedded(list, base = defaultBase()) {
  return (list || []).map((a) => publicAttachment({ _id: a.attachment, name: a.name, mime: a.mime, size: a.size, kind: a.kind }, base));
}

module.exports = router;
module.exports.resolveAttachments = resolveAttachments;
module.exports.mapEmbedded = mapEmbedded;
module.exports.canAccess = canAccess;
module.exports.attachmentBase = attachmentBase;
