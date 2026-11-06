const crypto = require('crypto');

const AFFILIATE_CODE_PATTERN = /^[A-Z]{2}\d{4}$/;
const MAX_GENERATION_ATTEMPTS = 100;

function generateAffiliateCode() {
  const letters = String.fromCharCode(
    65 + crypto.randomInt(26),
    65 + crypto.randomInt(26),
  );
  return `${letters}${String(crypto.randomInt(10_000)).padStart(4, '0')}`;
}

function isAffiliateCode(value) {
  return AFFILIATE_CODE_PATTERN.test(String(value || '').trim().toUpperCase());
}

/**
 * Assign a six-character affiliate code (AA0000) atomically. The unique partial
 * index on User.affiliateCode is the final guard against concurrent collisions.
 */
async function ensureAffiliateCode(user) {
  if (!user) return null;
  if (isAffiliateCode(user.affiliateCode)) return user;

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    user.affiliateCode = generateAffiliateCode();
    try {
      await user.save();
      return user;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }

  throw new Error('Unable to allocate a unique affiliate code');
}

async function backfillAffiliateCodes(User) {
  const users = await User.find({ affiliateCode: { $nin: ['', null] } })
    .select('_id affiliateCode')
    .lean();
  const used = new Set(users.filter((user) => isAffiliateCode(user.affiliateCode)).map((user) => user.affiliateCode));
  const operations = [];

  for (const user of users) {
    if (isAffiliateCode(user.affiliateCode)) continue;
    let code;
    do code = generateAffiliateCode(); while (used.has(code));
    used.add(code);
    operations.push({ updateOne: { filter: { _id: user._id }, update: { $set: { affiliateCode: code } } } });
  }

  if (operations.length) await User.bulkWrite(operations, { ordered: false });
  return { scanned: users.length, updated: operations.length };
}

module.exports = {
  AFFILIATE_CODE_PATTERN,
  generateAffiliateCode,
  isAffiliateCode,
  ensureAffiliateCode,
  backfillAffiliateCodes,
};
