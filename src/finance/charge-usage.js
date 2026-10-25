const WalletTx = require('../models/WalletTx');
const { settleSale } = require('./settlement-engine');
const { taxCategoryFromProduct } = require('./tax-category');
const { getSpendableBalance, releaseHold } = require('../utils/wallet');
const { withWalletLock } = require('../utils/wallet-lock');

const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/** Short cache so per-request metering does not hit Mongo for the seller's tax profile every call. */
const PROFILE_TTL_MS = 60_000;
const profileCache = new Map();
async function sellerTaxProfileFor(sellerId) {
  const key = String(sellerId || '');
  if (!key) return null;
  const hit = profileCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const { resolveSellerTaxProfile } = require('./settlement-service');
  const value = await resolveSellerTaxProfile(sellerId).catch(() => null);
  if (profileCache.size > 5000) profileCache.clear();
  profileCache.set(key, { value, exp: Date.now() + PROFILE_TTL_MS });
  return value;
}

/**
 * Usage / metered charge: same settlement as checkout (commission ≠ tax).
 * PLATFORM_DIRECT does not credit a third-party seller.
 */
async function chargeUsage({
  buyerId,
  sellerId,
  product,
  cost,
  currency = 'USD',
  note = 'Usage',
  digits = 6,
  commissionRules = [],
  taxRules = [],
  storeFeeRules = [],
  salesChannel = 'WEB',
  sellerTaxProfile = null,
  /** Pending debit from wallet.placeHold to finalize (its amount counts as spendable). */
  holdId = null,
  /**
   * 'none' (legacy: debit unconditionally), 'require' (402 when the buyer can't cover it),
   * 'cap' (charge at most what the buyer can cover — metered time that already elapsed).
   * Any policy other than 'none' runs check+debit under the per-user wallet lock.
   */
  funds = 'none',
  meta = null,
}) {
  const ownershipType = product?.ownershipType || 'THIRD_PARTY_SELLER';
  const selfUse = String(buyerId) === String(sellerId);
  if (!(cost > 0) || selfUse) {
    if (holdId) await releaseHold(holdId);
    return { charged: 0, sellerNet: 0, platformFee: 0, settlement: null, skipped: true };
  }

  // Use the seller's real tax profile (type) unless the caller passed one; previously null here meant
  // the engine default (INDIVIDUAL) for every usage event.
  const taxProfile = sellerTaxProfile || (ownershipType === 'THIRD_PARTY_SELLER' ? await sellerTaxProfileFor(sellerId) : null);

  const settleFor = (unitPrice) => settleSale({
    unitPrice,
    quantity: 1,
    ownershipType,
    product: { ...product, taxCategory: taxCategoryFromProduct(product) },
    seller: { _id: sellerId },
    sellerTaxProfile: taxProfile,
    commissionRules,
    taxRules,
    storeFeeRules,
    salesChannel,
    currency,
    digits,
  });

  const guarded = Boolean(holdId) || funds === 'require' || funds === 'cap';
  if (!guarded) return writeCharge(settleFor(cost));
  return withWalletLock(buyerId, async () => {
    let settlement = settleFor(cost);
    const hold = holdId ? await WalletTx.findOne({ _id: holdId, user: buyerId, status: 'pending' }).lean() : null;
    const spendable = round6((await getSpendableBalance(buyerId)) + (Number(hold?.amount) || 0));
    let shortfall = 0;
    if (settlement.grossAmount > spendable + 1e-9) {
      if (funds === 'require') {
        if (hold) await releaseHold(hold._id);
        const err = new Error(`Insufficient available wallet balance (need ${settlement.grossAmount.toFixed(4)} ${currency}).`);
        err.status = 402;
        err.code = 'INSUFFICIENT_WALLET';
        err.body = { amount: settlement.grossAmount, available: spendable, currency };
        throw err;
      }
      // Never drive the ledger negative: bill what the buyer can cover and record the rest.
      shortfall = round6(settlement.grossAmount - spendable);
      const capped = Math.floor(spendable * 10 ** digits) / 10 ** digits;
      if (!(capped > 0)) {
        if (hold) await releaseHold(hold._id);
        return { charged: 0, sellerNet: 0, platformFee: 0, settlement: null, skipped: true, shortfall };
      }
      let unit = capped;
      settlement = settleFor(unit);
      for (let i = 0; i < 100 && settlement.grossAmount > spendable + 1e-9 && unit > 0; i += 1) {
        unit = round6(unit - 10 ** -digits);
        settlement = settleFor(unit);
      }
    }
    const out = await writeCharge(settlement, hold);
    return shortfall > 0 ? { ...out, shortfall } : out;
  });

  async function writeCharge(settlement, hold = null) {
    const debit = { amount: settlement.grossAmount, currency, note, ...(meta ? { meta } : {}) };
    const finalized = hold
      ? await WalletTx.findOneAndUpdate(
          { _id: hold._id, status: 'pending' },
          { $set: { ...debit, status: 'completed', meta: { ...(hold.meta || {}), ...(meta || {}), kind: 'usage', reservedAmount: hold.amount } } },
          { new: true }
        )
      : null;
    if (!finalized) {
      await WalletTx.create({ user: buyerId, type: 'debit', ...debit });
    }

    if (ownershipType === 'THIRD_PARTY_SELLER' && settlement.sellerNetAmount > 0) {
      await WalletTx.create({
        user: sellerId,
        type: 'credit',
        amount: settlement.sellerNetAmount,
        currency,
        note: `${note} (seller payable after commission/tax)`,
      });
    }

    return {
      charged: settlement.grossAmount,
      sellerNet: settlement.sellerNetAmount,
      platformFee: settlement.platformRevenueAmount,
      settlement,
      skipped: false,
    };
  }
}

module.exports = { chargeUsage, sellerTaxProfileFor, _profileCache: profileCache };
