/** Query helpers for the admin "users & products" browser (GET /v1/admin/users, /v1/admin/products). */

const ADMIN_PAGE_SIZES = [20, 50, 100];
const USER_ROLES = ['buyer', 'seller', 'talent', 'freelancer', 'employer', 'admin'];
const USER_STATUSES = ['active', 'suspended', 'blocked', 'inactive', 'deleted'];
const PRODUCT_STATUSES = ['published', 'unpublished', 'suspended', 'blocked', 'inactive', 'pending_review'];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** page/limit/q from the query string, clamped (limit 20|50|100, q ≤ 100 chars). */
function adminListParams(query) {
  const limitRaw = Number.parseInt(String(query.limit || ''), 10);
  const limit = ADMIN_PAGE_SIZES.includes(limitRaw) ? limitRaw : ADMIN_PAGE_SIZES[0];
  const pageRaw = Number.parseInt(String(query.page || ''), 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 100000) : 1;
  const q = String(query.q || '').trim().slice(0, 100);
  return { page, limit, q, rx: q ? new RegExp(escapeRegex(q), 'i') : null };
}

function pageResult(items, total, page, limit) {
  return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

/** Accounts with no stored status are active (see utils/moderation effectiveStatus). */
function userStatusFilter(status) {
  if (status === 'active') return { accountStatus: { $in: ['active', null] } };
  return { accountStatus: status };
}

function productStatusFilter(status) {
  if (status === 'published') {
    return { published: { $ne: false }, moderationStatus: { $in: ['active', null] } };
  }
  if (status === 'unpublished') return { published: false };
  return { moderationStatus: status };
}

module.exports = {
  ADMIN_PAGE_SIZES,
  USER_ROLES,
  USER_STATUSES,
  PRODUCT_STATUSES,
  escapeRegex,
  adminListParams,
  pageResult,
  userStatusFilter,
  productStatusFilter,
};
