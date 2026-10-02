const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const Product = require('../models/Product');
const BuilderProject = require('../models/BuilderProject');
const BuilderTemplate = require('../models/BuilderTemplate');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { mapProduct } = require('../utils/mappers');
const { catalogVisibleFilter, isCatalogVisible } = require('../utils/moderation');
const { apiBase } = require('../utils/training/bundle');
const { TEMPLATE_CATEGORY_KIND } = require('../data/categories');
const files = require('../utils/builder/files');
const { readZip, isZip } = require('../utils/builder/zip');
const { previewResponse } = require('../utils/builder/preview');
const tpl = require('../utils/builder/templates');
const { publicProject, errorBody, newPreviewToken, maxProjects } = require('./builder');

/**
 * Seller templates for AI App Builder. A template is a regular Product (category
 * template-web / template-app, sold through the normal checkout) plus a BuilderTemplate
 * holding its files. Buyers who own it get a private BuilderProject copy to restyle with AI.
 * Mounted at /v1/builder/templates before /v1/builder (whose router requires auth).
 */
const router = express.Router();

const TEMPLATE_CATEGORIES = Object.keys(TEMPLATE_CATEGORY_KIND);
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const UPLOAD_MAX_FILES = 300;

const upload = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: { fileSize: UPLOAD_MAX_BYTES, files: UPLOAD_MAX_FILES },
});

function httpError(status, code, extra) {
  return files.httpError(status, code, extra);
}

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (!err || !err.status || !err.code) return next(err);
      return res.status(err.status).json(errorBody(err));
    }
  };
}

function receiveFiles(req, res, next) {
  upload.array('files', UPLOAD_MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'ZIP_TOO_LARGE' : 'UPLOAD_INVALID';
    return res.status(400).json(errorBody(httpError(400, code, { maxBytes: UPLOAD_MAX_BYTES })));
  });
}

function demoUrl(productId) {
  return `${apiBase()}/v1/builder/templates/${productId}/demo/`;
}

function isOwner(user, product) {
  return !!user && (user.role === 'admin' || String(product.creator) === String(user._id));
}

function templateMeta(product, template, { access = false, paths = false } = {}) {
  const list = template?.files || [];
  return {
    productId: String(product._id),
    kind: tpl.templateKind(product.category),
    ready: list.length > 0,
    version: template?.version || 0,
    fileCount: list.length,
    demoEnabled: template ? template.demoEnabled !== false : true,
    demoUrl: tpl.demoVisible(product, template) ? demoUrl(product._id) : '',
    useCount: template?.useCount || 0,
    updatedAt: template?.updatedAt || null,
    access,
    ...(paths ? { paths: list.map((f) => f.path) } : {}),
  };
}

async function loadTemplateProduct(id) {
  if (!mongoose.isValidObjectId(id)) throw httpError(404, 'TEMPLATE_NOT_FOUND');
  const product = await Product.findById(id);
  if (!product || !tpl.isTemplateCategory(product.category)) throw httpError(404, 'TEMPLATE_NOT_FOUND');
  return product;
}

// ---------- public live demo (sandboxed like project previews) ----------

router.get(/^\/([a-f0-9]{24})\/demo(?:\/(.*))?$/, async (req, res, next) => {
  try {
    const [id, rest] = [req.params[0], req.params[1]];
    if (rest === undefined) return res.redirect(302, `${req.baseUrl}/${id}/demo/`);
    const product = await Product.findById(id).select('name category moderationStatus suspendedUntil published').lean();
    const template = product ? await BuilderTemplate.findOne({ product: id }).lean() : null;
    if (!product || !tpl.isTemplateCategory(product.category) || !tpl.demoVisible(product, template)) {
      return res.status(404).type('text/plain').send('Demo not found');
    }
    const out = previewResponse({ name: product.name, kind: template.kind, files: template.files }, rest);
    res.status(out.status).set(out.headers).send(out.body);
  } catch (err) {
    next(err);
  }
});

// ---------- catalog ----------

/** GET /v1/builder/templates?kind=web|app — published templates that have files. */
router.get(
  '/',
  optionalAuth,
  wrap(async (req, res) => {
    const kind = String(req.query.kind || '');
    const categories = TEMPLATE_CATEGORIES.filter((c) => !kind || TEMPLATE_CATEGORY_KIND[c] === kind);
    const products = await Product.find({ category: { $in: categories }, ...catalogVisibleFilter() })
      .sort({ featured: -1, salesCount: -1, publishedAt: -1 })
      .limit(100)
      .lean();
    const templates = await BuilderTemplate.find({ product: { $in: products.map((p) => p._id) } })
      .select('product version demoEnabled useCount updatedAt files.path')
      .lean();
    const byProduct = new Map(templates.map((t) => [String(t.product), t]));
    const ready = products.filter((p) => byProduct.get(String(p._id))?.files?.length);
    const access = await tpl.accessibleIds(req.user, ready);
    res.json({
      templates: ready.map((p) => ({
        product: mapProduct(p),
        template: templateMeta(p, byProduct.get(String(p._id)), { access: access.has(String(p._id)) }),
      })),
    });
  })
);

/** GET /v1/builder/templates/mine — the seller's own template listings (any status). */
router.get(
  '/mine',
  authenticate,
  wrap(async (req, res) => {
    const filter = { category: { $in: TEMPLATE_CATEGORIES } };
    if (req.user.role !== 'admin' || req.query.all !== 'true') filter.creator = req.user._id;
    const products = await Product.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
    const templates = await BuilderTemplate.find({ product: { $in: products.map((p) => p._id) } })
      .select('product version demoEnabled useCount updatedAt files.path')
      .lean();
    const byProduct = new Map(templates.map((t) => [String(t.product), t]));
    res.json({
      templates: products.map((p) => ({
        product: { ...mapProduct(p), moderationStatus: p.moderationStatus || 'active', published: p.published !== false },
        template: templateMeta(p, byProduct.get(String(p._id)), { access: true, paths: true }),
      })),
    });
  })
);

/** GET /v1/builder/templates/:productId — template info for the product page. */
router.get(
  '/:productId',
  optionalAuth,
  wrap(async (req, res) => {
    const product = await loadTemplateProduct(req.params.productId);
    const owner = isOwner(req.user, product);
    if (!owner && !isCatalogVisible(product)) throw httpError(404, 'TEMPLATE_NOT_FOUND');
    const template = await BuilderTemplate.findOne({ product: product._id }).select('-files.content').lean();
    res.json({
      template: templateMeta(product, template, {
        access: await tpl.hasTemplateAccess(req.user, product),
        paths: true,
      }),
      isOwner: owner,
    });
  })
);

// ---------- seller: files + settings ----------

async function entriesFromRequest(req, kind) {
  const fromProject = String(req.body?.fromProject || '').trim();
  if (fromProject) {
    if (!mongoose.isValidObjectId(fromProject)) throw httpError(404, 'PROJECT_NOT_FOUND');
    const project = await BuilderProject.findOne({ _id: fromProject, owner: req.user._id }).select('kind files').lean();
    if (!project) throw httpError(404, 'PROJECT_NOT_FOUND');
    if (project.kind !== kind) throw httpError(400, 'TEMPLATE_KIND_MISMATCH');
    return project.files.map((f) => ({ path: f.path, data: f.content }));
  }
  const uploads = req.files || [];
  if (!uploads.length) throw httpError(400, 'TEMPLATE_EMPTY');
  const entries = [];
  for (const f of uploads) {
    if (isZip(f.buffer)) entries.push(...readZip(f.buffer));
    else entries.push({ path: f.originalname, data: f.buffer });
  }
  return entries;
}

/**
 * PUT /v1/builder/templates/:productId/files — replaces the template's files.
 * multipart `files` (a .zip, or many files with folder-relative names) or { fromProject }.
 */
router.put(
  '/:productId/files',
  authenticate,
  receiveFiles,
  wrap(async (req, res) => {
    const product = await loadTemplateProduct(req.params.productId);
    if (!isOwner(req.user, product)) throw httpError(403, 'TEMPLATE_FORBIDDEN');
    const kind = tpl.templateKind(product.category);
    const { files: clean, skipped } = tpl.normalizeUpload(kind, await entriesFromRequest(req, kind));
    const template =
      (await BuilderTemplate.findOne({ product: product._id })) ||
      new BuilderTemplate({ product: product._id, owner: product.creator, kind });
    template.kind = kind;
    template.files = clean;
    template.version += 1;
    await template.save();
    res.json({ template: templateMeta(product, template, { access: true, paths: true }), skipped });
  })
);

/** PATCH /v1/builder/templates/:productId — body { demoEnabled } */
router.patch(
  '/:productId',
  authenticate,
  wrap(async (req, res) => {
    const product = await loadTemplateProduct(req.params.productId);
    if (!isOwner(req.user, product)) throw httpError(403, 'TEMPLATE_FORBIDDEN');
    const template = await BuilderTemplate.findOne({ product: product._id });
    if (!template) throw httpError(404, 'TEMPLATE_EMPTY');
    if (req.body?.demoEnabled !== undefined) template.demoEnabled = !!req.body.demoEnabled;
    await template.save();
    res.json({ template: templateMeta(product, template, { access: true, paths: true }) });
  })
);

// ---------- buyer: start a project from a template ----------

/** POST /v1/builder/templates/:productId/use — body { name? } → private BuilderProject copy. */
router.post(
  '/:productId/use',
  authenticate,
  wrap(async (req, res) => {
    const product = await loadTemplateProduct(req.params.productId);
    const owner = isOwner(req.user, product);
    if (!owner && !isCatalogVisible(product)) throw httpError(404, 'TEMPLATE_NOT_FOUND');
    const template = await BuilderTemplate.findOne({ product: product._id }).lean();
    if (!template?.files?.length) throw httpError(404, 'TEMPLATE_EMPTY');
    if (!(await tpl.hasTemplateAccess(req.user, product))) {
      throw httpError(402, 'TEMPLATE_PURCHASE_REQUIRED', { productSlug: product.slug });
    }
    const count = await BuilderProject.countDocuments({ owner: req.user._id });
    if (count >= maxProjects()) throw httpError(409, 'PROJECT_LIMIT');
    const name = String(req.body?.name || product.name).trim().replace(/\s+/g, ' ').slice(0, 80) || product.name.slice(0, 80);
    const doc = await BuilderProject.create({
      owner: req.user._id,
      name,
      kind: template.kind,
      files: template.files.map((f) => ({ path: f.path, content: f.content })),
      template: { product: product._id, name: product.name.slice(0, 200), version: template.version },
      previewToken: newPreviewToken(),
    });
    await BuilderTemplate.updateOne({ _id: template._id }, { $inc: { useCount: 1 } });
    res.status(201).json({ project: publicProject(doc, true) });
  })
);

module.exports = router;
module.exports.templateMeta = templateMeta;
