const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { getExchangeRates, getAdminExchangeRates, setAdminOverride } = require('../finance/exchange-rate');

const router = express.Router();

/** Public display rate: VND and CNY per 1 USD, plus where it came from. */
router.get('/', async (_req, res, next) => {
  try {
    const quote = await getExchangeRates();
    res.json({
      base: quote.base,
      provider: quote.provider,
      vndPerUsd: quote.vndPerUsd,
      cnyPerUsd: quote.cnyPerUsd,
      rates: quote.rates,
      source: quote.source,
      updatedAt: quote.updatedAt,
      stale: quote.stale,
    });
  } catch (err) {
    next(err);
  }
});

const adminRouter = express.Router();
const admin = [authenticate, requireRoles('admin')];

adminRouter.get('/', ...admin, async (_req, res, next) => {
  try {
    res.json(await getAdminExchangeRates());
  } catch (err) {
    next(err);
  }
});

/**
 * Optional override. Send `null` to clear a side and go back to the live rate.
 * Bounds match the display service (VND 1,000–100,000; CNY 1–30 per USD).
 */
adminRouter.put('/', ...admin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'vndPerUsd')) {
      const parsed = parseOverride(body.vndPerUsd, 1000, 100000);
      if (parsed.error) return res.status(400).json({ message: 'vndPerUsd must be between 1000 and 100000, or null to clear' });
      patch.vndPerUsd = parsed.value;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'cnyPerUsd')) {
      const parsed = parseOverride(body.cnyPerUsd, 1, 30);
      if (parsed.error) return res.status(400).json({ message: 'cnyPerUsd must be between 1 and 30, or null to clear' });
      patch.cnyPerUsd = parsed.value;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ message: 'Provide vndPerUsd and/or cnyPerUsd' });
    }
    res.json(await setAdminOverride(patch));
  } catch (err) {
    next(err);
  }
});

function parseOverride(raw, min, max) {
  if (raw === null || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return { error: true };
  return { value: n };
}

module.exports = router;
module.exports.adminRouter = adminRouter;
