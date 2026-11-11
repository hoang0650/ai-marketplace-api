/**
 * Marketplace roles — single source of truth for role names and capabilities.
 *
 * Active roles (Quy chế 2.1, policy 2026-10):
 * - buyer  : buys with non-withdrawable, non-transferable prepaid credit. Refund requests
 *            are handled under the refund policy. Wallet credit from an admin refund is not
 *            a return to the original payment method.
 * - seller : third-party seller; seller type is mandatory (INDIVIDUAL / HOUSEHOLD_BUSINESS / COMPANY)
 *            with MST (and ĐKKD for household business / company) — see utils/seller-compliance.js
 * - admin  : ban quản trị (full platform ops, bypasses capability gates)
 *
 * Affiliate (Người tiếp thị liên kết) is a signup role. The account can buy and cannot sell.
 * Signing up records intent only. It does not issue an affiliate code. Existing buyer and
 * seller accounts keep their role. A code still requires the existing issuance flow, which
 * stays closed until statutory electronic identity exists.
 *
 * Least-privilege admin permissions (`User.adminPermissions`): a non-admin account (e.g. kế toán
 * thuế) can be granted only `finance.tax` (tax exports + Mẫu 08/CK-TNCN queue). Admins keep full access.
 *
 * Legacy Work roles (talent | freelancer | employer): Work/Hire is shut down (410). The enum keeps
 * them so existing accounts still load and can withdraw their remaining balance, but they are no
 * longer offered at signup.
 *
 * Strict split: each role only does its own job. `admin` is always allowed.
 * Legacy `creator` is an alias for `seller` (see normalizeRole / migration).
 */

const ROLE = Object.freeze({
  BUYER: 'buyer',
  SELLER: 'seller',
  AFFILIATE: 'affiliate',
  TALENT: 'talent',
  FREELANCER: 'freelancer',
  EMPLOYER: 'employer',
  ADMIN: 'admin',
});

/** Persisted enum on User.role. */
const USER_ROLES = Object.freeze(Object.values(ROLE));

/** Roles a user may pick for themselves at signup (never admin). */
const SIGNUP_ROLES = Object.freeze([ROLE.BUYER, ROLE.SELLER, ROLE.AFFILIATE]);

/** Roles kept only for existing accounts (Work/Hire discontinued). */
const LEGACY_WORK_ROLES = Object.freeze([ROLE.TALENT, ROLE.FREELANCER, ROLE.EMPLOYER]);

/** Least-privilege admin permissions grantable to non-admin staff accounts. */
const ADMIN_PERMISSION = Object.freeze({
  /** Tax exports (quarterly report, PIT certificates) and Mẫu 08/CK-TNCN review. */
  TAX: 'finance.tax',
});
const ADMIN_PERMISSIONS = Object.freeze(Object.values(ADMIN_PERMISSION));

/** Admin always passes; other accounts only with the explicit permission. */
function hasAdminPermission(user, permission) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  const granted = Array.isArray(user.adminPermissions) ? user.adminPermissions : [];
  return ADMIN_PERMISSIONS.includes(permission) && granted.includes(permission);
}

function normalizeAdminPermissions(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((p) => String(p || '').trim()).filter((p) => ADMIN_PERMISSIONS.includes(p)))];
}

/** Roles that earn money on the platform (eligible for payout / eKYC). */
const EARNER_ROLES = Object.freeze([ROLE.SELLER, ROLE.TALENT, ROLE.FREELANCER]);

/** Capability matrix (admin is implicitly allowed everywhere). */
const CAPABILITIES = Object.freeze({
  /** Publish products, coupons, deployments, servers, usage, content, seller dashboard. */
  sell: Object.freeze([ROLE.SELLER]),
  /** Create/own a talent profile. */
  talentProfile: Object.freeze([ROLE.TALENT]),
  /** Apply to job postings and deliver the work. */
  freelance: Object.freeze([ROLE.FREELANCER]),
  /** Post job openings (HR). */
  hire: Object.freeze([ROLE.EMPLOYER]),
  /** Needs a SellerProfile (compliance) for payouts. */
  sellerProfile: Object.freeze([ROLE.SELLER, ROLE.TALENT, ROLE.FREELANCER]),
  /** Sees both their sales and their purchases. */
  orderSeller: Object.freeze([ROLE.SELLER, ROLE.TALENT, ROLE.FREELANCER]),
});

/** Legacy → current role. Before the migration script runs some rows still say 'creator'. */
function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === 'creator') return ROLE.SELLER;
  return value;
}

function isAdmin(user) {
  const role = typeof user === 'string' ? user : user?.role;
  return normalizeRole(role) === ROLE.ADMIN;
}

function roleOf(user) {
  return normalizeRole(typeof user === 'string' ? user : user?.role);
}

/** True when the user holds any of `roles` (or is admin). */
function hasAnyRole(user, roles = []) {
  const role = roleOf(user);
  if (!role) return false;
  if (role === ROLE.ADMIN) return true;
  return roles.map(normalizeRole).includes(role);
}

function hasCapability(user, capability) {
  const allowed = CAPABILITIES[capability] || [];
  return hasAnyRole(user, allowed);
}

/** Roles + admin — handy for `requireRoles(...)`. */
function withAdmin(roles) {
  return [...roles, ROLE.ADMIN];
}

function isSignupRole(role) {
  return SIGNUP_ROLES.includes(normalizeRole(role));
}

function isEarnerRole(user) {
  return EARNER_ROLES.includes(roleOf(user));
}

module.exports = {
  ROLE,
  USER_ROLES,
  SIGNUP_ROLES,
  LEGACY_WORK_ROLES,
  ADMIN_PERMISSION,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  normalizeAdminPermissions,
  EARNER_ROLES,
  CAPABILITIES,
  normalizeRole,
  roleOf,
  isAdmin,
  hasAnyRole,
  hasCapability,
  withAdmin,
  isSignupRole,
  isEarnerRole,
};
