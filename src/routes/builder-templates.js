const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const Product = require('../models/Product');
const BuilderProject = require('../models/BuilderProject');
const BuilderTemplate = require('../models/BuilderTemplate');
const TemplateBuild = require('../models/TemplateBuild');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { mapProduct } = require('../utils/mappers');
const { catalogVisibleFilter, isCatalogVisible } = require('../utils/moderation');
const { apiBase } = require('../utils/training/bundle');
const { TEMPLATE_CATEGORY_KIND } = require('../data/categories');
const files = require('../utils/builder/files');
const { readZip, isZip } = require('../utils/builder/zip');
const { previewResponse } = require('../utils/builder/preview');
const tpl = require('../utils/builder/templates');
const gh = require('../utils/builder/github');
const { runBuild, createLog } = require('../utils/builder/template-build');
const { publicProject, errorBody, newPreviewToken, maxProjects } = require('./builder');
const { useConnection, guard } = require('./builder-git');

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
const REPO_DIR_RE = /^[A-Za-z0-9_.\- /]{1,200}$/;
const BUILD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const importing = new Set();

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

/** Seller-only: where the files were imported from (the repo may be private). */
function gitSource(template) {
  const s = template?.source;
  if (!s?.repo) return null;
  return {
    provider: s.provider || 'github',
    repo: s.repo,
    branch: s.branch || '',
    path: s.path || '',
    commitSha: s.commitSha || '',
    repoUrl: s.repoUrl || `https://github.com/${s.repo}`,
    syncedAt: s.syncedAt || null,
  };
}

function templateMeta(product, template, { access = false, paths = false, git = false } = {}) {
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
    ...(git ? { git: gitSource(template) } : {}),
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
      .select('product version demoEnabled useCount updatedAt files.path source')
      .lean();
    const byProduct = new Map(templates.map((t) => [String(t.product), t]));
    res.json({
      templates: products.map((p) => ({
        product: { ...mapProduct(p), moderationStatus: p.moderationStatus || 'active', published: p.published !== false },
        template: templateMeta(p, byProduct.get(String(p._id)), { access: true, paths: true, git: true }),
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
        git: owner,
      }),
      isOwner: owner,
    });
  })
);

// ---------- seller: files + settings ----------

function cleanRepoDir(raw) {
  const dir = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!dir) return '';
  if (!REPO_DIR_RE.test(dir) || dir.split('/').some((s) => !s.trim() || s === '.' || s === '..')) {
    throw httpError(400, 'GIT_PATH_INVALID');
  }
  return dir;
}

function describe(err) {
  return errorBody(err).message;
}

/** { repo: "owner/name", branch?, path? } → validated pick (bad input is a 400, not a failed build). */
function gitPick(src) {
  const ref = gh.parseFullName(src?.repo);
  if (!ref) throw httpError(400, 'GIT_REPO_INVALID');
  const branch = String(src.branch || '').trim();
  if (branch && !gh.validBranch(branch)) throw httpError(400, 'GIT_BRANCH_INVALID');
  return { ...ref, branch, dir: cleanRepoDir(src.path) };
}

function publicBuild(b) {
  const ok = b.status === 'success';
  return {
    id: String(b._id),
    kind: b.kind,
    status: b.status,
    source: b.source?.repo ? { ...b.source } : null,
    log: b.log || [],
    fileCount: (b.files || []).length,
    paths: (b.files || []).map((f) => f.path),
    skipped: b.skipped || [],
    durationMs: b.durationMs || 0,
    createdAt: b.createdAt || null,
    previewUrl: ok ? `${apiBase()}/v1/builder/templates/builds/${b._id}/${b.previewToken}/` : '',
    productId: b.product ? String(b.product) : null,
  };
}

/** Fetches the repo and runs the template checks; always stores a TemplateBuild with its log. */
async function runGitBuild(user, kind, src) {
  const pick = gitPick(src);
  const { conn, token } = await useConnection(user._id);
  const log = createLog();
  const where = `${pick.owner}/${pick.repo}${pick.branch ? `@${pick.branch}` : ''}${pick.dir ? ` /${pick.dir}` : ''}`;
  log.info(`Nguồn: github.com/${where}`);
  const lim = files.limits();
  const classify = (path, size) => {
    if (path.split('/').some((s) => s.startsWith('.')) || tpl.JUNK_RE.test(path)) return 'junk';
    if (!files.cleanPath(kind, path)) return 'type';
    return size > lim.fileMaxBytes ? 'size' : '';
  };

  let fetched = null;
  try {
    fetched = await guard(conn, async () => {
      const info = await gh.getRepo(token, pick.owner, pick.repo);
      const branch = pick.branch || info.default_branch || 'main';
      const owner = info.owner?.login || pick.owner;
      log.info(`Đang tải branch ${branch}${pick.dir ? `, thư mục /${pick.dir}` : ''}…`);
      const pulled = await gh.fetchRepoFiles(token, { owner, repo: info.name, ref: branch, dir: pick.dir, classify, maxFiles: lim.maxFiles });
      log.info(`Commit ${pulled.sha.slice(0, 7)}${pulled.message ? `: ${pulled.message}` : ''}`);
      return { ...pulled, branch, fullName: info.full_name || `${owner}/${info.name}`, htmlUrl: info.html_url };
    });
  } catch (err) {
    if (err?.code === 'GIT_TOKEN_INVALID' || !err?.code) throw err;
    log.error(describe(err));
  }

  const result = runBuild({ kind, entries: fetched ? fetched.entries : null, dropped: fetched?.skipped || [], describe }, log);
  return TemplateBuild.create({
    owner: user._id,
    kind,
    status: result.ok ? 'success' : 'failed',
    source: fetched
      ? {
          provider: 'github',
          repo: fetched.fullName,
          branch: fetched.branch,
          path: pick.dir,
          commitSha: fetched.sha,
          commitMessage: fetched.message,
          repoUrl: fetched.htmlUrl,
        }
      : { provider: 'github', repo: `${pick.owner}/${pick.repo}`, branch: pick.branch, path: pick.dir },
    log: result.log,
    files: result.files,
    skipped: result.skipped.slice(0, 200),
    durationMs: result.durationMs,
    previewToken: newPreviewToken(),
    expiresAt: new Date(Date.now() + BUILD_TTL_MS),
  });
}

/** Copies a successful build onto the listing's template (new version, remembered source). */
async function applyBuild(product, template, build) {
  template.kind = build.kind;
  template.files = build.files.map((f) => ({ path: f.path, content: f.content }));
  const plain = typeof build.toObject === 'function' ? build.toObject() : build;
  const source = { ...(plain.source || {}) };
  delete source.commitMessage;
  template.source = source.repo ? { ...source, syncedAt: new Date() } : undefined;
  template.version += 1;
  await template.save();
  await TemplateBuild.updateOne({ _id: build._id }, { $set: { product: product._id } });
}

/** → { entries, skipped } from an upload or a builder project. */
async function entriesFromRequest(req, kind) {
  const fromProject = String(req.body?.fromProject || '').trim();
  if (fromProject) {
    if (!mongoose.isValidObjectId(fromProject)) throw httpError(404, 'PROJECT_NOT_FOUND');
    const project = await BuilderProject.findOne({ _id: fromProject, owner: req.user._id }).select('kind files template').lean();
    if (!project) throw httpError(404, 'PROJECT_NOT_FOUND');
    if (project.kind !== kind) throw httpError(400, 'TEMPLATE_KIND_MISMATCH');
    if (project.template?.product) {
      const creator =
        project.template.creator || (await Product.findById(project.template.product).select('creator').lean())?.creator;
      if (String(creator || '') !== String(req.user._id)) throw httpError(403, 'TEMPLATE_RESALE_FORBIDDEN');
    }
    return { entries: project.files.map((f) => ({ path: f.path, data: f.content })), skipped: [] };
  }
  const uploads = req.files || [];
  if (!uploads.length) throw httpError(400, 'TEMPLATE_EMPTY');
  const entries = [];
  for (const f of uploads) {
    if (isZip(f.buffer)) entries.push(...readZip(f.buffer));
    else entries.push({ path: f.originalname, data: f.buffer });
  }
  return { entries, skipped: [] };
}

// ---------- builds (GitHub → checks → publish) ----------

/** Sandboxed preview of a successful build, so sellers can look before publishing. */
router.get(/^\/builds\/([a-f0-9]{24})\/([A-Za-z0-9_-]{16,64})(?:\/(.*))?$/, async (req, res, next) => {
  try {
    const [id, token, rest] = [req.params[0], req.params[1], req.params[2]];
    if (rest === undefined) return res.redirect(302, `${req.baseUrl}/builds/${id}/${token}/`);
    const build = await TemplateBuild.findById(id).lean();
    if (!build || build.status !== 'success' || build.previewToken !== token) {
      return res.status(404).type('text/plain').send('Build not found');
    }
    const out = previewResponse({ name: build.source?.repo || 'Template build', kind: build.kind, files: build.files }, rest);
    res.status(out.status).set(out.headers).send(out.body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/builder/templates/builds
 * body { kind: 'web'|'app', fromGit: { repo, branch?, path? } } — new listing, or
 * { productId, fromGit? } — rebuild an existing listing (defaults to its saved GitHub source).
 * Always 201 with the build; `status: 'failed'` carries the log explaining what to fix.
 */
router.post(
  '/builds',
  authenticate,
  wrap(async (req, res) => {
    const body = req.body || {};
    let kind = String(body.kind || '');
    let src = body.fromGit;
    if (body.productId) {
      const product = await loadTemplateProduct(String(body.productId));
      if (!isOwner(req.user, product)) throw httpError(403, 'TEMPLATE_FORBIDDEN');
      kind = tpl.templateKind(product.category);
      if (!src) {
        const saved = await BuilderTemplate.findOne({ product: product._id }).select('source').lean();
        if (!saved?.source?.repo) throw httpError(400, 'GIT_REPO_REQUIRED');
        src = saved.source;
      }
    }
    if (!['web', 'app'].includes(kind)) throw httpError(400, 'PROJECT_KIND_INVALID');
    const key = `user:${req.user._id}`;
    if (importing.has(key)) throw httpError(409, 'TEMPLATE_BUSY');
    importing.add(key);
    try {
      const build = await runGitBuild(req.user, kind, src);
      res.status(201).json({ build: publicBuild(build) });
    } finally {
      importing.delete(key);
    }
  })
);

/** GET /v1/builder/templates/builds/:id — the seller's own build (log + status). */
router.get(
  '/builds/:id',
  authenticate,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'TEMPLATE_BUILD_NOT_FOUND');
    const build = await TemplateBuild.findOne({ _id: req.params.id, owner: req.user._id }).lean();
    if (!build) throw httpError(404, 'TEMPLATE_BUILD_NOT_FOUND');
    res.json({ build: publicBuild(build) });
  })
);

/**
 * PUT /v1/builder/templates/:productId/files — replaces the template's files from
 * multipart `files` (a .zip, or many files with folder-relative names), { fromProject },
 * { fromBuild } (a successful build) or { fromGit } (build now; { sync: true } = saved source).
 * A failed GitHub build answers 422 TEMPLATE_BUILD_FAILED with `build` (log) and changes nothing.
 */
router.put(
  '/:productId/files',
  authenticate,
  receiveFiles,
  wrap(async (req, res) => {
    const product = await loadTemplateProduct(req.params.productId);
    if (!isOwner(req.user, product)) throw httpError(403, 'TEMPLATE_FORBIDDEN');
    const kind = tpl.templateKind(product.category);
    const key = String(product._id);
    if (importing.has(key)) throw httpError(409, 'TEMPLATE_BUSY');
    importing.add(key);
    try {
      const template =
        (await BuilderTemplate.findOne({ product: product._id })) ||
        new BuilderTemplate({ product: product._id, owner: product.creator, kind });
      const body = req.body || {};

      if (body.fromBuild || body.fromGit) {
        let build;
        if (body.fromBuild) {
          if (!mongoose.isValidObjectId(String(body.fromBuild))) throw httpError(404, 'TEMPLATE_BUILD_NOT_FOUND');
          build = await TemplateBuild.findOne({ _id: String(body.fromBuild), owner: req.user._id });
          if (!build) throw httpError(404, 'TEMPLATE_BUILD_NOT_FOUND');
        } else {
          const sync = body.fromGit === true || body.fromGit?.sync === true;
          if (sync && !template.source?.repo) throw httpError(400, 'GIT_REPO_REQUIRED');
          build = await runGitBuild(req.user, kind, sync ? template.source : body.fromGit);
        }
        if (build.kind !== kind) throw httpError(400, 'TEMPLATE_KIND_MISMATCH');
        if (build.status !== 'success') throw httpError(422, 'TEMPLATE_BUILD_FAILED', { build: publicBuild(build) });
        await applyBuild(product, template, build);
        return res.json({
          template: templateMeta(product, template, { access: true, paths: true, git: true }),
          skipped: build.skipped || [],
          build: publicBuild(build),
        });
      }

      const { entries, skipped: dropped } = await entriesFromRequest(req, kind);
      const normalized = tpl.normalizeUpload(kind, entries);
      template.kind = kind;
      template.files = normalized.files;
      template.source = undefined;
      template.version += 1;
      await template.save();
      res.json({
        template: templateMeta(product, template, { access: true, paths: true, git: true }),
        skipped: [...dropped, ...normalized.skipped],
      });
    } finally {
      importing.delete(key);
    }
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
    if (req.body?.unlinkGit) template.source = undefined;
    await template.save();
    res.json({ template: templateMeta(product, template, { access: true, paths: true, git: true }) });
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
      template: { product: product._id, creator: product.creator || null, name: product.name.slice(0, 200), version: template.version },
      previewToken: newPreviewToken(),
    });
    await BuilderTemplate.updateOne({ _id: template._id }, { $inc: { useCount: 1 } });
    res.status(201).json({ project: publicProject(doc, true) });
  })
);

module.exports = router;
module.exports.templateMeta = templateMeta;
