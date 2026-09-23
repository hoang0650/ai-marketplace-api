/**
 * Migrate marketplace roles: legacy `creator` → `seller`.
 *
 * The User.role enum is now: buyer | seller | talent | freelancer | employer | admin.
 * `creator` is kept as an in-code alias (utils/roles.js#normalizeRole) so old JWTs
 * and cached sessions keep working, but persisted rows should be normalized.
 *
 * Usage: npm run migrate:roles
 */
require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../config/env');
const User = require('../models/User');
const Product = require('../models/Product');
const { ROLE } = require('../utils/roles');

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('[migrate-roles] connected');

  const legacy = await User.countDocuments({ role: 'creator' });
  if (legacy > 0) {
    const res = await User.updateMany({ role: 'creator' }, { $set: { role: ROLE.SELLER } });
    console.log(`[migrate-roles] creator → seller: ${res.modifiedCount}/${legacy}`);
  } else {
    console.log('[migrate-roles] no legacy creator rows');
  }

  // Sellers without a slug cannot reach their shop — backfill from name/email.
  const missingSlug = await User.find({ role: ROLE.SELLER, $or: [{ creatorSlug: { $exists: false } }, { creatorSlug: '' }] })
    .select('name email')
    .lean();
  for (const u of missingSlug) {
    const base = String(u.name || u.email || 'seller')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'seller';
    let slug = base;
    // eslint-disable-next-line no-await-in-loop
    while (await User.exists({ creatorSlug: slug })) {
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }
    // eslint-disable-next-line no-await-in-loop
    await User.updateOne({ _id: u._id }, { $set: { creatorSlug: slug } });
    console.log(`[migrate-roles] slug ${u.email} → ${slug}`);
  }

  // Report buyers that still own products: strict split means they cannot sell anymore.
  const owners = await Product.distinct('creator');
  const stranded = await User.countDocuments({ _id: { $in: owners }, role: ROLE.BUYER });
  if (stranded > 0) {
    console.warn(
      `[migrate-roles] WARNING: ${stranded} user(s) with role=buyer still own products. ` +
        'Promote them to seller manually, e.g. ' +
        `db.users.updateMany({ _id: { $in: [...] } }, { $set: { role: 'seller' } }).`,
    );
  }

  const counts = await User.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
  console.log('[migrate-roles] role counts:', counts.map((c) => `${c._id || 'none'}=${c.n}`).join(' '));

  await mongoose.disconnect();
  console.log('[migrate-roles] done');
}

main().catch((err) => {
  console.error('[migrate-roles] failed:', err);
  process.exit(1);
});
