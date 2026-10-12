const express = require('express');
const Product = require('../models/Product');
const BuilderTemplate = require('../models/BuilderTemplate');
const User = require('../models/User');
const { authenticate, requireRoles, invalidateAuthUserCache } = require('../middleware/auth');
const { ROLE } = require('../utils/roles');
const { mapProduct } = require('../utils/mappers');
const { slugify } = require('../utils/serialize');
const { productSlugQuery, isCatalogProductSlug } = require('../utils/product-slug');
const { cached, deleteCachePattern } = require('../utils/cache');
const { PRODUCT_CATEGORIES, PROFESSIONAL_SERVICE_CATEGORIES } = require('../data/categories');
const { normalizeRuntime } = require('../utils/runtime');
const { inferProductType } = require('../data/marketplace-types');
const { catalogVisibleFilter, isCatalogVisible } = require('../utils/moderation');
const { assertCanPublishProduct } = require('../utils/seller-compliance');
const { writeAuditLog } = require('../utils/audit');
const { normalizeContentMeta, isVoiceCategory } = require('../utils/license-keys');
const { applyVoiceProduct } = require('../utils/voice-clone');
const { normalizeDevices } = require('../utils/stream-clients');

const router = express.Router();

const LIST_TTL = 60; // s — listings change often (installs, new products)
const DETAIL_TTL = 300; // s

/** Product data changed — drop product + creator caches (fire-and-forget). */
function invalidateProductCaches() {
  deleteCachePattern('products:*').catch(() => {});
  deleteCachePattern('creators:*').catch(() => {});
  deleteCachePattern('home:*').catch(() => {});
  try {
    require('./categories').invalidateCategoryCounts();
  } catch {
    /* categories route may not export helper in older deploys */
  }
}

/** GPU/game stream settings; only platform listings may route to a platform GPU workspace offer. */
function normalizeStreaming(raw, { ownershipType, defaults = {} } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rentalOfferId =
    ownershipType === 'PLATFORM_DIRECT'
      ? String(src.rentalOfferId ?? defaults.rentalOfferId ?? '').trim().slice(0, 120)
      : '';
  return {
    devices: normalizeDevices(src.devices ?? defaults.devices),
    rentalOfferId,
  };
}

/** Escape user input before embedding in a RegExp (prevents ReDoS / regex injection). */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.category) {
      const cat = String(req.query.category);
      if (!PRODUCT_CATEGORIES.includes(cat)) return res.json([]);
      filter.category = cat;
    } else {
      filter.category = { $in: PRODUCT_CATEGORIES };
    }
    Object.assign(filter, catalogVisibleFilter());
    if (req.query.creatorSlug) filter.creatorSlug = String(req.query.creatorSlug).toLowerCase();
    if (req.query.featured === 'true') filter.featured = true;

    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) {
      const safe = new RegExp(escapeRegExp(q), 'i');
      filter.$or = [
        { name: safe },
        { tagline: safe },
        { description: safe },
        { tags: safe },
      ];
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const sortKey = String(req.query.sort || 'featured');
    const sort =
      sortKey === 'newest' || sortKey === 'new'
        ? { publishedAt: -1, createdAt: -1 }
        : sortKey === 'bestsellers' || sortKey === 'sales'
          ? { salesCount: -1, rating: -1, publishedAt: -1 }
          : { featured: -1, publishedAt: -1 };

    const cacheKey = `products:list:${req.query.category || ''}:${req.query.creatorSlug || ''}:${req.query.featured || ''}:${sortKey}:${q}:${limit}:${offset}`;
    const result = await cached(cacheKey, LIST_TTL, async () => {
      const products = await Product.find(filter)
        .sort(sort)
        .skip(offset)
        .limit(limit)
        .lean();
      return products.map(mapProduct);
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug).toLowerCase();
    const result = await cached(`products:slug:${slug}`, DETAIL_TTL, async () => {
      const product = await Product.findOne(productSlugQuery(slug)).lean();
      if (!product || !isCatalogVisible(product)) return null;
      return mapProduct(product);
    });
    if (!result) return res.status(404).json({ message: 'Not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Talent accounts may only offer professional services; sellers may list every category. */
function talentCategoryError(user, category) {
  if (user.role !== ROLE.TALENT || PROFESSIONAL_SERVICE_CATEGORIES.includes(String(category))) return null;
  return {
    message:
      'Tài khoản này chỉ được đăng dịch vụ chuyên môn trọn gói: Làm web, Làm app, Marketing, SEO, Creator, Tự động hóa.',
    code: 'CATEGORY_NOT_ALLOWED',
    allowed: PROFESSIONAL_SERVICE_CATEGORIES,
  };
}

/**
 * Professional services are fixed packages (Quy chế 2.1, khoản 6 Mục X): one-time price per
 * package / deliverable — never hourly, daily or monthly, never a negotiable quote.
 */
function hirePricing(category, pricing) {
  if (!PROFESSIONAL_SERVICE_CATEGORIES.includes(String(category))) return pricing;
  const src = pricing && typeof pricing === 'object' ? pricing : {};
  return {
    model: 'one-time',
    price: Math.max(0, Number(src.price) || 0),
    currency: String(src.currency || 'USD'),
    interval: null,
    compareAtPrice: Math.max(0, Number(src.compareAtPrice) || 0),
    negotiable: false,
  };
}

/** A professional-service package must carry a fixed checkout price. */
function servicePricingError(category, pricing) {
  if (!PROFESSIONAL_SERVICE_CATEGORIES.includes(String(category))) return null;
  if (Number(pricing?.price) > 0) return null;
  return {
    message: 'Dịch vụ chuyên môn trọn gói phải có giá cố định theo gói (không báo giá, không tính theo giờ/tháng).',
    code: 'SERVICE_PACKAGE_PRICE_REQUIRED',
  };
}

async function ensureCreatorSlug(user) {
  if (user.creatorSlug) return user.creatorSlug;
  const fresh = await User.findById(user._id).select('creatorSlug').lean();
  let slug = fresh?.creatorSlug;
  if (!slug) {
    slug = slugify(user.name) || `talent-${Date.now().toString(36)}`;
    if (await User.exists({ creatorSlug: slug })) slug = `${slug}-${Date.now().toString(36)}`;
    await User.updateOne({ _id: user._id }, { $set: { creatorSlug: slug } });
    await invalidateAuthUserCache(user._id);
  }
  user.creatorSlug = slug;
  return slug;
}

router.post('/', authenticate, requireRoles('seller', 'talent', 'admin'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name || !body.category || !body.pricing) {
      return res.status(400).json({ message: 'name, category, pricing are required' });
    }
    if (!PRODUCT_CATEGORIES.includes(String(body.category))) {
      return res.status(400).json({ message: 'AI marketplace category required' });
    }
    const forbidden = talentCategoryError(req.user, body.category);
    if (forbidden) return res.status(403).json(forbidden);
    const badServicePrice = servicePricingError(body.category, body.pricing);
    if (badServicePrice) return res.status(400).json(badServicePrice);
    let slug = slugify(body.slug || name);
    if (!slug) slug = `product-${Date.now()}`;
    if (isCatalogProductSlug(slug) && req.user.role !== 'admin') slug = `p-${slug}`;
    const exists = await Product.findOne({ slug });
    if (exists) slug = `${slug}-${Date.now().toString(36)}`;

    const user = req.user;
    if (user.role === 'seller' && !user.creatorSlug) {
      return res.status(400).json({ message: 'Seller profile missing slug' });
    }
    if (user.role === ROLE.TALENT) await ensureCreatorSlug(user);

    const requestedOwnership =
      body.ownershipType === 'PLATFORM_DIRECT' ? 'PLATFORM_DIRECT' : 'THIRD_PARTY_SELLER';
    const wantsPublish = body.published !== false;

    let ownershipType = requestedOwnership;
    if (wantsPublish || requestedOwnership === 'PLATFORM_DIRECT') {
      try {
        const publishGate = await assertCanPublishProduct(user, {
          ownershipType: requestedOwnership,
        });
        ownershipType = publishGate.ownershipType;
      } catch (err) {
        if (requestedOwnership === 'PLATFORM_DIRECT' || wantsPublish) {
          return res.status(err.status || 403).json({
            message: err.message,
            code: err.code || undefined,
            verificationStatus: err.verificationStatus,
          });
        }
      }
    }

    const moderationStatus =
      ownershipType === 'PLATFORM_DIRECT' || user.role === 'admin'
        ? wantsPublish
          ? 'active'
          : 'inactive'
        : wantsPublish
          ? 'pending_review'
          : 'inactive';

    const published =
      ownershipType === 'PLATFORM_DIRECT' || user.role === 'admin'
        ? wantsPublish
        : false;

    const infraProvider = String(body.infraProvider || body.provider || '');

    const product = await Product.create({
      slug,
      name,
      tagline: body.tagline || '',
      description: body.description || '',
      category: body.category,
      creator: user._id,
      creatorSlug: user.creatorSlug || 'admin',
      creatorName: user.name,
      ownershipType,
      infraProvider,
      provider: infraProvider,
      license: body.license || '',
      termsSummary: body.termsSummary || '',
      complianceStatus: ownershipType === 'PLATFORM_DIRECT' ? 'approved' : 'pending',
      coverUrl: body.coverUrl || '',
      gallery: Array.isArray(body.gallery) ? body.gallery : [],
      pricing: hirePricing(body.category, body.pricing),
      runtime: normalizeRuntime(body.runtime || {}, {
        defaults: { baseModel: name },
      }),
      contentMeta: normalizeContentMeta(body.category, body.contentMeta) || undefined,
      streaming: normalizeStreaming(body.streaming, { ownershipType }),
      tags: Array.isArray(body.tags) ? body.tags : [],
      apiDocsMarkdown: body.apiDocsMarkdown || '',
      changelog: Array.isArray(body.changelog) ? body.changelog : [],
      featured: !!body.featured,
      publishedAt: body.publishedAt ? new Date(body.publishedAt) : new Date(),
      productType: body.productType || inferProductType(body.category, body.tags),
      published,
      moderationStatus,
    });

    if (isVoiceCategory(product.category)) {
      applyVoiceProduct(product);
      await product.save();
    }

    await writeAuditLog({
      actorId: user._id,
      actorRole: user.role,
      action: 'PRODUCT_CREATE',
      resourceType: 'Product',
      resourceId: product._id,
      newValue: { ownershipType, moderationStatus, slug, published },
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    invalidateProductCaches();
    res.status(201).json(mapProduct(product, { includeSecrets: true }));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', authenticate, requireRoles('seller', 'talent', 'admin'), async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Not found' });
    if (
      req.user.role !== 'admin' &&
      String(product.creator) !== String(req.user._id)
    ) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const body = req.body || {};
    if (body.category !== undefined && !PRODUCT_CATEGORIES.includes(String(body.category))) {
      return res.status(400).json({ message: 'AI marketplace category required' });
    }
    const forbidden = talentCategoryError(req.user, body.category ?? product.category);
    if (forbidden) return res.status(403).json(forbidden);
    const fields = [
      'name',
      'tagline',
      'description',
      'category',
      'coverUrl',
      'gallery',
      'pricing',
      'tags',
      'apiDocsMarkdown',
      'changelog',
      'featured',
      'contentMeta',
    ];
    for (const key of fields) {
      if (body[key] !== undefined) product[key] = body[key];
    }
    if (body.pricing !== undefined || body.category !== undefined) {
      const plain = product.pricing?.toObject?.() || product.pricing;
      const badServicePrice = servicePricingError(product.category, plain);
      if (badServicePrice) return res.status(400).json(badServicePrice);
      product.pricing = hirePricing(product.category, plain);
    }
    if (body.contentMeta !== undefined || body.category) {
      product.contentMeta = normalizeContentMeta(product.category, body.contentMeta || product.contentMeta) || product.contentMeta;
    }
    if (body.runtime !== undefined) {
      product.runtime = normalizeRuntime(body.runtime, {
        defaults: product.runtime?.toObject?.() || product.runtime || {},
      });
    }
    if (body.streaming !== undefined) {
      product.streaming = normalizeStreaming(body.streaming, {
        ownershipType: product.ownershipType,
        defaults: product.streaming?.toObject?.() || product.streaming || {},
      });
    }
    if (body.slug) {
      const next = slugify(body.slug);
      if (next && (req.user.role === 'admin' || !isCatalogProductSlug(next))) product.slug = next;
    }
    if (isVoiceCategory(product.category)) {
      applyVoiceProduct(product);
    }
    await product.save();
    invalidateProductCaches();
    res.json(mapProduct(product, { includeSecrets: true }));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticate, requireRoles('seller', 'talent', 'admin'), async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Not found' });
    if (
      req.user.role !== 'admin' &&
      String(product.creator) !== String(req.user._id)
    ) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    await product.deleteOne();
    await BuilderTemplate.deleteOne({ product: product._id });
    invalidateProductCaches();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.talentCategoryError = talentCategoryError;
module.exports.hirePricing = hirePricing;
module.exports.servicePricingError = servicePricingError;
