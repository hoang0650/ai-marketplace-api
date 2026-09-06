const express = require('express');
const LegalDocument = require('../models/LegalDocument');
const LegalAcceptance = require('../models/LegalAcceptance');
const { LEGAL_DOCUMENT_TYPES } = LegalDocument;
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function mapDoc(doc, { includeContent = true } = {}) {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  const base = {
    id: String(o._id || o.id),
    documentType: o.documentType,
    version: o.version,
    title: o.title,
    locale: o.locale || 'vi',
    summary: o.summary || '',
    effectiveAt: o.effectiveAt ? new Date(o.effectiveAt).toISOString() : null,
    publishedAt: o.publishedAt ? new Date(o.publishedAt).toISOString() : null,
    status: o.status,
  };
  if (includeContent) base.content = o.content;
  return base;
}

router.get('/types', (_req, res) => {
  res.json(LEGAL_DOCUMENT_TYPES);
});

router.get('/me/acceptances', authenticate, async (req, res, next) => {
  try {
    const rows = await LegalAcceptance.find({ user: req.user._id }).sort({ acceptedAt: -1 }).lean();
    res.json(
      rows.map((r) => ({
        documentType: r.documentType,
        version: r.version,
        acceptedAt: r.acceptedAt ? new Date(r.acceptedAt).toISOString() : null,
        context: r.context,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const locale = String(req.query.locale || 'vi');
    const docs = await LegalDocument.find({ status: 'published', locale })
      .sort({ documentType: 1, effectiveAt: -1 })
      .lean();

    const latestByType = new Map();
    for (const d of docs) {
      if (!latestByType.has(d.documentType)) latestByType.set(d.documentType, d);
    }
    res.json([...latestByType.values()].map((d) => mapDoc(d, { includeContent: false })));
  } catch (err) {
    next(err);
  }
});

router.get('/:documentType', async (req, res, next) => {
  try {
    const documentType = String(req.params.documentType);
    const locale = String(req.query.locale || 'vi');
    const version = req.query.version ? String(req.query.version) : null;

    const filter = { documentType, status: 'published', locale };
    if (version) filter.version = version;

    const doc = await LegalDocument.findOne(filter).sort({ effectiveAt: -1 }).lean();
    if (!doc) return res.status(404).json({ message: 'Legal document not found' });
    res.json(mapDoc(doc));
  } catch (err) {
    next(err);
  }
});

router.post('/:documentType/accept', authenticate, async (req, res, next) => {
  try {
    const documentType = String(req.params.documentType);
    const locale = String(req.body?.locale || 'vi');
    const context = String(req.body?.context || 'manual');

    const doc = await LegalDocument.findOne({
      documentType,
      status: 'published',
      locale,
    })
      .sort({ effectiveAt: -1 })
      .lean();

    if (!doc) return res.status(404).json({ message: 'Legal document not found' });

    const acceptance = await LegalAcceptance.findOneAndUpdate(
      {
        user: req.user._id,
        documentType,
        version: doc.version,
      },
      {
        $set: {
          documentId: doc._id,
          acceptedAt: new Date(),
          ip: req.ip || '',
          userAgent: req.get('user-agent') || '',
          context: ['register', 'seller_onboarding', 'checkout', 'manual'].includes(context)
            ? context
            : 'manual',
        },
      },
      { upsert: true, new: true },
    );

    res.json({
      documentType,
      version: doc.version,
      acceptedAt: acceptance.acceptedAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
