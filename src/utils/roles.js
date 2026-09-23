/**
 * Marketplace roles — single source of truth for role names and capabilities.
 *
 * role: buyer | seller | talent | freelancer | employer | admin
 * - buyer      : buys only
 * - seller     : publishes products/services (shop, coupons, compute, content)
 * - talent     : creates ONE talent profile (recruited)
 * - freelancer : applies to jobs (does the work)
 * - employer   : posts jobs / HR hiring
 * - admin      : platform ops (bypasses capability gates)
 *
 * Strict split: each role only does its own job. `admin` is always allowed.
 * Legacy `creator` is an alias for `seller` (see normalizeRole / migration).
 */

const ROLE = Object.freeze({
  BUYER: 'buyer',
  SELLER: 'seller',
  TALENT: 'talent',
  FREELANCER: 'freelancer',
  EMPLOYER: 'employer',
  ADMIN: 'admin',
});

/** Persisted enum on User.role. */
const USER_ROLES = Object.freeze(Object.values(ROLE));

/** Roles a user may pick for themselves at signup (never admin). */
const SIGNUP_ROLES = Object.freeze([ROLE.BUYER, ROLE.SELLER, ROLE.TALENT, ROLE.FREELANCER, ROLE.EMPLOYER]);

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
