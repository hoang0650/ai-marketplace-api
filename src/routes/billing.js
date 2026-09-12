const express = require('express');
const Product = require('../models/Product');
const Order = require('../models/Order');
const WalletTx = require('../models/WalletTx');
const Notification = require('../models/Notification');
const SellerProfile = require('../models/SellerProfile');
const LegalDocument = require('../models/LegalDocument');
const { authenticate } = require('../middleware/auth');
const { deleteCachePattern } = require('../utils/cache');
const { clampQty } = require('../utils/sales');
const { getBalance } = require('../utils/wallet');
const { HOLD_MS } = require('../utils/payout-hold');
const { recordOrderLedger } = require('../finance/ledger-service');
const { settleSaleFromDb } = require('../finance/settlement-service');
const { recordTaxPostings } = require('../finance/tax-posting');
const { issueOrderInvoices } = require('../finance/invoice-service');
const { taxCategoryFromProduct } = require('../finance/tax-category');
const { writeAuditLog } = require('../utils/audit');
const { normalizeSalesChannel } = require('../finance/store-fee-engine');
const { isLicenseCategory, resolveLicensePrice } = require('../utils/license-keys');
const { issueLicenseForOrder, mapLicense } = require('../utils/issue-license');
const { findActiveLicense } = require('../utils/content-drm');
const { sendCheckoutSuccessEmail } = require('../utils/send-checkout-email');

const router = express.Router();

router.post('/checkout', authenticate, async (req, res, next) => {
  try {
    const productId = req.body?.productId;
    const quantity = clampQty(req.body?.quantity);
    if (!productId) return res.status(400).json({ message: 'productId required' });

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const ownershipType = product.ownershipType || 'THIRD_PARTY_SELLER';
    const licensePick = isLicenseCategory(product.category)
      ? resolveLicensePrice(product.toObject ? product.toObject() : product, req.body?.licenseTerm)
      : null;
    if (licensePick && !(licensePick.unitPrice > 0)) {
      return res.status(400).json({
        message: 'This product has no license price. It cannot be unlocked for free.',
        code: 'LICENSE_PRICE_REQUIRED',
      });
    }
    if (licensePick) {
      const existing = await findActiveLicense({ buyerId: req.user._id, productId: product._id });
      if (existing) {
        return res.json({
          checkoutId: `chk_licensed_${existing._id}`,
          provider: 'wallet',
          paymentProvider: 'internal_ledger',
          status: 'paid',
          alreadyLicensed: true,
          amount: 0,
          currency: product.pricing?.currency || 'USD',
          license: mapLicense(existing),
          orderId: existing.order ? String(existing.order) : undefined,
        });
      }
    } else {
      const existingOrder = await Order.findOne({
        buyer: req.user._id,
        product: product._id,
        status: 'paid',
      }).sort({ createdAt: -1 });
      if (existingOrder) {
        return res.json({
          checkoutId: `chk_owned_${existingOrder._id}`,
          provider: 'wallet',
          paymentProvider: 'internal_ledger',
          status: 'paid',
          alreadyPurchased: true,
          amount: 0,
          currency: product.pricing?.currency || 'USD',
          orderId: String(existingOrder._id),
        });
      }
    }
    const unit = licensePick
      ? licensePick.unitPrice
      : product.pricing?.model === 'usage'
        ? Number(product.pricing.usageRate) || 0
        : Number(product.pricing.price) || 0;
    const currency = product.pricing?.currency || 'USD';

    const salesChannel = normalizeSalesChannel(req.body?.salesChannel);
    const checkoutQty = licensePick ? 1 : quantity;
    const settlement = await settleSaleFromDb({
      unitPrice: unit,
      quantity: checkoutQty,
      ownershipType,
      seller: { _id: product.creator, sellerType: undefined },
      sellerId: product.creator,
      buyer: { country: '' },
      product: product.toObject ? product.toObject() : product,
      paymentMethod: salesChannel === 'WEB' ? 'internal_ledger' : salesChannel,
      salesChannel,
      currency,
      digits: 2,
    });

    const amount = settlement.grossAmount;

    if (amount > 0) {
      const balance = await getBalance(req.user._id);
      if (balance < amount) {
        return res.status(402).json({
          message: `Insufficient internal ledger entitlement (need ${amount.toFixed(2)} ${currency}, have ${balance.toFixed(2)}). Top up via licensed payment rails when available.`,
          code: 'INSUFFICIENT_WALLET',
          amount,
          balance,
          currency,
        });
      }
    }

    const now = new Date();
    const sellerProfile = await SellerProfile.findOne({ user: product.creator }).lean();
    const termsDoc = await LegalDocument.findOne({
      documentType: 'terms',
      status: 'published',
      locale: 'vi',
    })
      .sort({ effectiveAt: -1 })
      .lean();
    const refundDoc = await LegalDocument.findOne({
      documentType: 'refund-policy',
      status: 'published',
      locale: 'vi',
    })
      .sort({ effectiveAt: -1 })
      .lean();

    const order = await Order.create({
      product: product._id,
      productName: product.name,
      buyer: req.user._id,
      buyerName: req.user.name,
      seller: product.creator,
      ownershipType,
      quantity: checkoutQty,
      amount,
      currency,
      unitPrice: settlement.unitPrice,
      grossAmount: settlement.grossAmount,
      commissionRate: settlement.commissionRate,
      commissionAmount: settlement.commissionAmount,
      commissionRuleId: settlement.commissionRuleId,
      taxAmount: settlement.taxAmount,
      taxBreakdown: settlement.taxBreakdown,
      taxCategory: settlement.taxCategory || taxCategoryFromProduct(product),
      paymentFeeAmount: settlement.paymentFeeAmount,
      salesChannel: settlement.salesChannel,
      storeFeeRate: settlement.storeFeeRate,
      storeFeeAmount: settlement.storeFeeAmount,
      storeFeeCollector: settlement.storeFeeCollector || '',
      refundAmount: 0,
      chargebackAmount: 0,
      sellerGrossAmount: settlement.sellerGrossAmount,
      sellerNetAmount: settlement.sellerNetAmount,
      platformRevenueAmount: settlement.platformRevenueAmount,
      sellerNet: settlement.sellerNetAmount,
      platformFee: settlement.platformRevenueAmount,
      financialSnapshot: settlement,
      completedAt: now,
      payoutHoldUntil:
        ownershipType === 'THIRD_PARTY_SELLER' ? new Date(now.getTime() + HOLD_MS) : now,
      disputeStatus: 'none',
      status: 'paid',
      paymentStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
      paymentProvider: 'internal_ledger',
      provider: 'wallet',
      contractSnapshot: {
        productName: product.name,
        productDescription: product.description || product.tagline || '',
        sellerDisplayName: product.creatorName,
        sellerLegalName: sellerProfile?.legalName || product.creatorName,
        ownershipType,
        pricing: product.pricing,
        license: product.license || '',
        termsSummary: product.termsSummary || '',
        refundPolicyVersion: refundDoc?.version || '',
        termsVersion: termsDoc?.version || '',
        infraProvider: product.infraProvider || product.provider || '',
        commissionRate: settlement.commissionRate,
        salesChannel: settlement.salesChannel,
        storeFeeRate: settlement.storeFeeRate,
        licenseTerm: licensePick?.term || '',
      },
    });

    if (amount > 0) {
      await WalletTx.create({
        user: req.user._id,
        type: 'debit',
        amount,
        currency,
        note: `Order ${order._id} · ${product.name} ×${quantity} (internal ledger entitlement)`,
      });
      if (ownershipType === 'THIRD_PARTY_SELLER' && settlement.sellerNetAmount > 0) {
        await WalletTx.create({
          user: product.creator,
          type: 'credit',
          amount: settlement.sellerNetAmount,
          currency,
          note: `Seller payable: ${product.name} (commission ${settlement.commissionAmount} snapshot, store ${settlement.storeFeeAmount}, tax ${settlement.taxAmount})`,
        });
      }
      await recordOrderLedger({
        order,
        settlement,
        ownershipType,
        currency,
      }).catch((err) => console.error('[ledger]', err.message));
      await recordTaxPostings({ order, settlement }).catch((err) => console.error('[tax]', err.message));
      await issueOrderInvoices(order, settlement).catch((err) => console.error('[invoice]', err.message));
    }

    await Product.updateOne({ _id: product._id }, { $inc: { salesCount: quantity } });
    deleteCachePattern('products:*').catch(() => {});
    deleteCachePattern('creators:*').catch(() => {});

    await Notification.create({
      user: product.creator,
      title: 'New order',
      body: `${req.user.name} purchased ${product.name} (${ownershipType})`,
      href: '/dashboard/orders',
    });

    await writeAuditLog({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: 'ORDER_PAID',
      resourceType: 'Order',
      resourceId: order._id,
      newValue: {
        ownershipType,
        amount,
        currency,
        commissionRate: settlement.commissionRate,
        commissionAmount: settlement.commissionAmount,
        taxAmount: settlement.taxAmount,
        sellerNetAmount: settlement.sellerNetAmount,
        licenseTerm: licensePick?.term || '',
      },
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    let license = null;
    if (licensePick) {
      const issued = await issueLicenseForOrder({
        order,
        product,
        term: licensePick.term,
      }).catch((err) => {
        console.error('[license]', err.message);
        return null;
      });
      if (issued) license = mapLicense(issued);
    }

    let mail = { ok: false, to: null, reason: 'ERROR' };
    try {
      mail = await sendCheckoutSuccessEmail({
        buyer: req.user,
        order,
        product,
        license,
      });
    } catch (err) {
      console.error('[mail] checkout email failed:', err.message);
    }

    await Notification.create({
      user: req.user._id,
      title: 'Thanh toán thành công',
      body: license?.licenseKey
        ? `${product.name} · license ${license.licenseKey}. Email xác nhận đã gửi.`
        : `${product.name} đã thanh toán bằng ví AI Markets.`,
      href: license?.licenseKey ? '/dashboard/licenses' : '/dashboard/orders',
    }).catch(() => {});

    const balance = await getBalance(req.user._id);
    res.status(201).json({
      checkoutId: `chk_${order._id.toString()}`,
      provider: 'wallet',
      paymentProvider: 'internal_ledger',
      ownershipType,
      status: 'paid',
      quantity: checkoutQty,
      amount,
      currency,
      commissionRate: settlement.commissionRate,
      commissionAmount: settlement.commissionAmount,
      taxAmount: settlement.taxAmount,
      platformFee: settlement.platformRevenueAmount,
      sellerNet: settlement.sellerNetAmount,
      balance,
      orderId: order._id.toString(),
      license,
      emailSent: !!mail?.ok,
      emailTo: mail?.to || null,
      emailReason: mail?.ok ? undefined : mail?.reason || mail?.error,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
