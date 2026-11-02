const MarketplaceApiKey = require('../models/MarketplaceApiKey');
const User = require('../models/User');
const { liftExpired, effectiveStatus, denyMessage } = require('../utils/moderation');

/**
 * Accept JWT or marketplace key (mk_live_…). Never logs the secret.
 */
async function authenticateMarketplaceKey(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith('mk_live_')) return next();
  try {
    const keyHash = MarketplaceApiKey.hashKey(token);
    const row = await MarketplaceApiKey.findOne({ keyHash, status: 'active' });
    if (!row) return res.status(401).json({ message: 'Invalid API key', code: 'UNAUTHORIZED' });
    const user = await User.findById(row.user);
    if (!user) return res.status(401).json({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (typeof user.save === 'function') await liftExpired(user, 'accountStatus');
    const status = effectiveStatus(user, 'accountStatus');
    if (status !== 'active') return res.status(403).json({ message: denyMessage(status), code: 'ACCOUNT_' + status.toUpperCase() });
    row.lastUsedAt = new Date();
    await row.save().catch(() => {});
    req.user = user;
    req.marketplaceKey = row;
    next();
  } catch {
    return res.status(401).json({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
  }
}

module.exports = { authenticateMarketplaceKey };
