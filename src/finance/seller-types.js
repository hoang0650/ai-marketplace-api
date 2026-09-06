const SELLER_TYPES = [
  'INDIVIDUAL',
  'HOUSEHOLD_BUSINESS',
  'COMPANY',
  'FOREIGN_INDIVIDUAL',
  'FOREIGN_COMPANY',
  'PLATFORM',
];

const LEGACY_MAP = {
  individual: 'INDIVIDUAL',
  household_business: 'HOUSEHOLD_BUSINESS',
  enterprise: 'COMPANY',
  organization: 'COMPANY',
  platform: 'PLATFORM',
};

function normalizeSellerType(raw) {
  if (!raw) return 'INDIVIDUAL';
  const key = String(raw).trim();
  if (LEGACY_MAP[key.toLowerCase()]) return LEGACY_MAP[key.toLowerCase()];
  const upper = key.toUpperCase().replace(/[\s-]+/g, '_');
  return SELLER_TYPES.includes(upper) ? upper : 'INDIVIDUAL';
}

module.exports = { SELLER_TYPES, normalizeSellerType };
