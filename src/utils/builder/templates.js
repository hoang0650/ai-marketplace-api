const Order = require('../../models/Order');
const { TEMPLATE_CATEGORY_KIND } = require('../../data/categories');
const { effectiveStatus } = require('../moderation');
const files = require('./files');

/**
 * Seller templates for AI App Builder: upload normalisation and buyer access rules.
 */

const ENTRY = {
  web: ['index.html'],
  app: ['App.tsx', 'App.jsx', 'App.ts', 'App.js'],
};

const JUNK_RE = /(^|\/)(__MACOSX|node_modules|\.git|\.expo|dist|build)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

function templateKind(category) {
  return TEMPLATE_CATEGORY_KIND[String(category || '')] || '';
}

function isTemplateCategory(category) {
  return !!templateKind(category);
}

/** "my-template/index.html", "my-template/css/a.css" → strip the shared top folder. */
function stripCommonRoot(paths) {
  if (!paths.length || paths.some((p) => !p.includes('/'))) return paths;
  const root = paths[0].split('/')[0];
  if (!paths.every((p) => p.startsWith(`${root}/`))) return paths;
  return stripCommonRoot(paths.map((p) => p.slice(root.length + 1)));
}

function decodeText(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8');
  if (buf.includes(0)) return null;
  const text = buf.toString('utf8');
  if (text.includes('\uFFFD')) return null;
  return text.replace(/^\uFEFF/, '');
}

/**
 * entries: [{ path, data: Buffer|string }] from a zip, a folder upload or a builder project.
 * Returns { files, skipped } or throws TEMPLATE_* / PROJECT_* errors.
 */
function normalizeUpload(kind, entries) {
  const lim = files.limits();
  const usable = (entries || [])
    .map((e) => ({ ...e, path: String(e.path || '').replace(/\\/g, '/').replace(/^\/+/, '') }))
    .filter((e) => e.path && !JUNK_RE.test(e.path));
  const roots = stripCommonRoot(usable.map((e) => e.path));
  const skipped = [];
  const map = new Map();
  usable.forEach((e, i) => {
    const path = files.cleanPath(kind, roots[i]);
    if (!path) return skipped.push({ path: e.path.slice(0, 160), reason: 'type' });
    const text = decodeText(e.data);
    if (text === null) return skipped.push({ path, reason: 'binary' });
    if (files.byteLength(text) > lim.fileMaxBytes) return skipped.push({ path, reason: 'size' });
    map.set(path, text);
  });
  const out = [...map.entries()].map(([path, content]) => ({ path, content }));
  if (!out.length) throw files.httpError(400, 'TEMPLATE_EMPTY', { skipped });
  if (!ENTRY[kind].some((p) => map.has(p))) {
    throw files.httpError(400, 'TEMPLATE_ENTRY_MISSING', { entry: ENTRY[kind][0], skipped });
  }
  files.checkProject(out);
  return { files: files.sortFiles(out), skipped };
}

function isOwnerOrAdmin(user, product) {
  return !!user && (user.role === 'admin' || String(product.creator) === String(user._id));
}

function isFreeListing(product) {
  const pricing = product.pricing || {};
  if (pricing.model === 'free') return true;
  return pricing.model === 'one-time' && !(Number(pricing.price) > 0);
}

/** Buyers may open the template in the builder once they own it. */
async function hasTemplateAccess(user, product) {
  if (!user || !product) return false;
  if (isOwnerOrAdmin(user, product)) return true;
  if (isFreeListing(product)) return true;
  return !!(await Order.exists({ buyer: user._id, product: product._id, status: 'paid' }));
}

/** Product ids (as strings) among `products` this user can use — one query for lists. */
async function accessibleIds(user, products) {
  const ids = new Set();
  if (!user) return ids;
  const paidCheck = [];
  for (const p of products) {
    if (isOwnerOrAdmin(user, p) || isFreeListing(p)) ids.add(String(p._id));
    else paidCheck.push(p._id);
  }
  if (paidCheck.length) {
    const rows = await Order.find({ buyer: user._id, product: { $in: paidCheck }, status: 'paid' }).distinct('product');
    rows.forEach((id) => ids.add(String(id)));
  }
  return ids;
}

/** Live demo stays reachable while a listing is under review so moderators can inspect it. */
function demoVisible(product, template) {
  if (!product || !template || !template.demoEnabled || !template.files?.length) return false;
  const status = effectiveStatus(product, 'moderationStatus');
  return status === 'active' || status === 'pending_review';
}

module.exports = {
  ENTRY,
  templateKind,
  isTemplateCategory,
  stripCommonRoot,
  normalizeUpload,
  isFreeListing,
  hasTemplateAccess,
  accessibleIds,
  demoVisible,
};
