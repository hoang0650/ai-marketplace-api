const { authenticate } = require('./auth');
const { authenticateMarketplaceKey } = require('./marketplace-key');

/** Bearer JWT (web) or Bearer mk_live_… (scripts / agents). */
function onlineAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ message: 'Sign in (Bearer JWT or mk_live_ API key) to use this product online.', code: 'AUTH_REQUIRED' });
  if (token.startsWith('mk_live_')) return authenticateMarketplaceKey(req, res, next);
  return authenticate(req, res, next);
}

/** An mk_live_ key is minted for one product; it cannot be used for another listing. */
function marketplaceKeyAllows(req, product) {
  if (!req.marketplaceKey) return true;
  return String(req.marketplaceKey.product) === String(product._id);
}

module.exports = { onlineAuth, marketplaceKeyAllows };
