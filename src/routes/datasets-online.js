/**
 * Online-only datasets.
 *
 *   GET /v1/datasets/:slug                       splits, row counts, columns, README, license notices, quotas
 *   GET /v1/datasets/:slug/rows?split=train&offset=0&limit=100
 *
 * Auth: Authorization: Bearer <JWT | mk_live_ key> + X-License-Key: AIM-… (the caller's own key).
 * The license is checked on every request; expiry takes effect immediately. Each row carries `_aim`,
 * a per-license fingerprint, and every response a verifiable trace id (X-Trace-Id).
 */
const express = require('express');
const Product = require('../models/Product');
const { productSlugQuery } = require('../utils/product-slug');
const { onlineAuth, marketplaceKeyAllows } = require('../middleware/online-auth');
const online = require('../utils/online-access');
const store = require('../utils/dataset-store');

const router = express.Router();

async function loadDataset(req, res) {
  const product = await Product.findOne({ ...productSlugQuery(req.params.slug), category: 'dataset' })
    .select('name slug category creator license')
    .lean();
  if (!product) {
    res.status(404).json({ message: 'Dataset not found', code: 'DATASET_NOT_FOUND' });
    return null;
  }
  if (!marketplaceKeyAllows(req, product)) {
    res.status(403).json({ message: 'This API key was created for another product.', code: 'API_KEY_PRODUCT_MISMATCH' });
    return null;
  }
  const access = await online.resolveOnlineAccess({
    user: req.user,
    product,
    licenseKey: req.get('x-license-key'),
    requireKey: true,
  });
  if (!access.via) {
    online.sendDenied(res, access.reason);
    return null;
  }
  return { product, access };
}

function scopeId(access, req) {
  return String(access.license?._id || req.user._id);
}

router.get('/:slug', onlineAuth, async (req, res, next) => {
  try {
    const ctx = await loadDataset(req, res);
    if (!ctx) return;
    const { product, access } = ctx;
    const { episodes, splits } = await store.datasetFiles(product._id);
    const out = [];
    for (const f of splits) {
      const entry = await store.loadSplit(f);
      if (entry) out.push({ name: f.stem, format: f.ext, rows: entry.rows.length, columns: entry.columns });
    }
    const readme = episodes.find((e) => /^readme\.md$/i.test(e.title));
    const notices = episodes.filter((e) => /^licen[cs]e.*\.(txt|md)$/i.test(e.title));
    const trace = online.traceId(scopeId(access, req));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Trace-Id', trace);
    res.json({
      dataset: product.slug,
      name: product.name,
      access: access.via,
      license: access.license ? { expiresAt: access.license.expiresAt, term: access.license.licenseTerm || null } : null,
      splits: out,
      readme: readme ? await store.readTextFile(readme, 64 * 1024) : '',
      licenseNotices: await Promise.all(notices.map(async (e) => ({ file: e.title, text: await store.readTextFile(e, 32 * 1024) }))),
      quota: online.quotaDefaults().dataset,
      traceId: trace,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/rows', onlineAuth, async (req, res, next) => {
  try {
    const ctx = await loadDataset(req, res);
    if (!ctx) return;
    const { product, access } = ctx;
    const limits = online.quotaDefaults().dataset;
    const { splits } = await store.datasetFiles(product._id);
    const file = store.resolveSplit(splits, req.query.split);
    if (!file) {
      return res.status(404).json({ message: 'Unknown split', code: 'SPLIT_NOT_FOUND', splits: splits.map((f) => f.stem) });
    }
    const entry = await store.loadSplit(file);
    if (!entry) return res.status(404).json({ message: 'Split is not row data', code: 'SPLIT_NOT_FOUND' });
    const total = entry.rows.length;
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    let limit = Math.floor(Number(req.query.limit) || limits.defaultLimit);
    limit = Math.max(1, Math.min(limit, limits.maxLimit));
    const want = Math.max(0, Math.min(limit, total - offset));

    let quota = null;
    let allowed = want;
    const metered = access.via === 'license';
    if (metered) {
      quota = await online.takeQuota({
        scope: online.usageScope(access, req.user, product),
        kind: 'dataset',
        wantUnits: want,
        limits: {
          requestsPerMinute: limits.requestsPerMinute,
          unitsPerMinute: limits.rowsPerMinute,
          unitsPerDay: limits.rowsPerDay,
        },
      });
      allowed = quota.allowedUnits;
    }
    const sid = scopeId(access, req);
    const rows = [];
    for (let i = offset; i < offset + allowed; i += 1) {
      const r = store.rowAt(entry, i);
      const wm = online.rowWatermark(sid, product._id, file.stem, i);
      rows.push(r && typeof r === 'object' && !Array.isArray(r) ? { ...r, _aim: wm } : { value: r, _aim: wm });
    }
    if (quota) await quota.commit(rows.length);
    const trace = online.traceId(sid);
    const next = offset + rows.length < total ? offset + rows.length : null;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Trace-Id', trace);
    if (quota?.remaining?.unitsToday != null) res.setHeader('X-RateLimit-Rows-Remaining-Day', String(quota.remaining.unitsToday));
    res.json({
      dataset: product.slug,
      split: file.stem,
      offset,
      limit,
      returned: rows.length,
      total,
      nextOffset: next,
      truncatedByQuota: rows.length < want,
      rows,
      access: access.via,
      licenseExpiresAt: access.license?.expiresAt || null,
      quota: quota ? quota.remaining : null,
      traceId: trace,
    });
  } catch (err) {
    if (err.status === 429) return online.sendQuotaError(res, err);
    if (err.status === 413) return res.status(413).json({ message: err.message, code: err.code });
    next(err);
  }
});

module.exports = router;
