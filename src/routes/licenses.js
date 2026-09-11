const express = require('express');
const LicenseKey = require('../models/LicenseKey');
const { authenticate } = require('../middleware/auth');
const { effectiveLicenseStatus, licenseCoversProduct } = require('../utils/license-keys');
const { mapLicense } = require('../utils/issue-license');

const router = express.Router();

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const rows = await LicenseKey.find({ buyer: req.user._id }).sort({ createdAt: -1 }).limit(200).lean();
    res.json(rows.map((r) => mapLicense(r)));
  } catch (err) {
    next(err);
  }
});

router.post('/validate', async (req, res, next) => {
  try {
    const key = String(req.body?.licenseKey || req.body?.key || '').trim().toUpperCase();
    if (!key) return res.status(400).json({ valid: false, message: 'licenseKey required' });
    const doc = await LicenseKey.findOne({ licenseKey: key });
    if (!doc) return res.status(404).json({ valid: false, status: 'not_found' });
    const productId = req.body?.productId ? String(req.body.productId) : '';
    if (productId && !licenseCoversProduct(doc, productId)) {
      return res.status(403).json({ valid: false, status: 'product_mismatch' });
    }
    const status = effectiveLicenseStatus(doc);
    if (status === 'active') {
      doc.lastValidatedAt = new Date();
      await doc.save();
    }
    res.json({
      valid: status === 'active',
      ...mapLicense(doc),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
