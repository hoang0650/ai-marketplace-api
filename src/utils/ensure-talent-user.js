const User = require('../models/User');
const { slugify } = require('../utils/serialize');

/**
 * Ensure a TalentProfile has a linked User so Work chat can open.
 * Seed profiles often have no `user` — auto-provision a mailbox identity.
 */
async function ensureTalentUser(talent) {
  if (!talent) return null;
  const existing = talent.user && (talent.user._id || talent.user);
  if (existing) return existing;

  const slug = String(talent.slug || '').trim().toLowerCase();
  const email = `talent+${slug}@users.aimarkets.vn`;
  let user = await User.findOne({ email });
  if (!user) {
    const name = String(talent.name || slug || 'Talent').trim().slice(0, 120) || 'Talent';
    try {
      user = await User.create({
        email,
        name,
        passwordHash: '',
        authProvider: 'local',
        avatarUrl: talent.avatarUrl || '',
        bio: String(talent.bio || '').slice(0, 500),
        role: 'talent',
        affiliateCode: `PHAI-T-${slugify(slug).slice(0, 10).toUpperCase() || 'TALENT'}`,
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      user = await User.findOne({ email });
    }
  }
  if (!user) return null;

  talent.user = user._id;
  if (!talent.avatarUrl && user.avatarUrl) talent.avatarUrl = user.avatarUrl;
  await talent.save();
  return user._id;
}

module.exports = { ensureTalentUser };
