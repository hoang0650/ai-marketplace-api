const { seedPasswordHash } = require('./seed-password');
const User = require('../models/User');
const Product = require('../models/Product');
const {
  CREATOR,
  buildRunpodMarketplaceProducts,
} = require('../data/runpod-marketplace-products');
const MarketplaceApiKey = require('../models/MarketplaceApiKey');
const Deployment = require('../models/Deployment');
const Conversation = require('../models/Conversation');
const { deleteCachePattern } = require('./cache');
const { LEGACY_PREFIX, canonicalProductSlug } = require('./product-slug');

const LEGACY_SLUG_RE = new RegExp(`^${LEGACY_PREFIX}`);

/** Rename platform catalog products `runpod-x` → `aim-x` and rewrite stored references. */
async function migrateLegacyCatalogSlugs() {
  const legacy = await Product.find(
    {
      slug: LEGACY_SLUG_RE,
      $or: [{ infraProvider: 'runpod' }, { creatorSlug: { $in: [CREATOR.creatorSlug, 'runpod'] } }],
    },
    { slug: 1 }
  ).lean();
  const renamed = new Map();
  for (const doc of legacy) {
    const next = canonicalProductSlug(doc.slug);
    if (await Product.exists({ slug: next })) {
      await Product.updateOne({ _id: doc._id }, { $set: { published: false } });
      continue;
    }
    await Product.updateOne({ _id: doc._id }, { $set: { slug: next } });
    renamed.set(doc.slug, next);
  }
  if (!renamed.size) return 0;

  const from = [...renamed.keys()];
  for (const Model of [MarketplaceApiKey, Deployment, Conversation]) {
    const rows = await Model.find({ productSlug: { $in: from } }, { productSlug: 1 }).lean();
    if (!rows.length) continue;
    await Model.bulkWrite(
      rows.map((r) => ({
        updateOne: { filter: { _id: r._id }, update: { $set: { productSlug: renamed.get(r.productSlug) } } },
      }))
    );
  }
  console.log(`[aimarkets] renamed ${renamed.size} legacy catalog slugs`);
  return renamed.size;
}

/**
 * Upsert catalog model products into MongoDB with white-labeled aimarkets.vn URLs.
 */
async function ensureRunpodMarketplaceProducts() {
  await migrateLegacyCatalogSlugs();

  let creator =
    (await User.findOne({ creatorSlug: CREATOR.creatorSlug })) ||
    (await User.findOne({ email: CREATOR.email })) ||
    (await User.findOne({ creatorSlug: 'runpod' }));

  if (!creator) {
    const passwordHash = await seedPasswordHash();
    creator = await User.create({
      email: CREATOR.email,
      passwordHash,
      name: CREATOR.name,
      role: 'seller',
      creatorSlug: CREATOR.creatorSlug,
      bio: CREATOR.bio,
      avatarUrl: CREATOR.avatarUrl,
      coverUrl: CREATOR.coverUrl,
      verified: true,
      affiliateCode: 'PHAI-AIMARKETS',
    });
    console.log('[aimarkets] created creator', CREATOR.creatorSlug);
  } else {
    creator.name = CREATOR.name;
    creator.creatorSlug = CREATOR.creatorSlug;
    creator.bio = CREATOR.bio;
    creator.avatarUrl = CREATOR.avatarUrl;
    creator.email = CREATOR.email;
    await creator.save();
  }

  const products = buildRunpodMarketplaceProducts();
  let upserted = 0;
  for (const p of products) {
    const runtime = {
      publicEndpoint: p.runtime.publicEndpoint,
      serverlessEndpoint: p.runtime.serverlessEndpoint,
      tokenizeEndpoint: p.runtime.tokenizeEndpoint || '',
      gatewayUrl: p.runtime.gatewayUrl || '',
      env: p.runtime.env || [],
      skills: p.runtime.skills || [],
      baseModel: p.runtime.baseModel,
      systemPrompt: '',
      temperature: 0.7,
      maxTokens: 1024,
    };
    // Demos are curated separately (real outputs); keep them and surface their media in the gallery.
    const existing = await Product.findOne({ slug: p.slug }).select('demos').lean();
    const demoMedia = (existing?.demos || [])
      .map((d) => (d.kind === 'image' ? d.url : d.kind === 'video' ? d.posterUrl : ''))
      .filter(Boolean);
    const gallery = [...new Set([...(p.gallery || []), ...demoMedia])];
    await Product.findOneAndUpdate(
      { slug: p.slug },
      {
        $set: {
          name: p.name,
          tagline: p.tagline,
          description: p.description,
          category: p.category,
          creator: creator._id,
          creatorSlug: CREATOR.creatorSlug,
          creatorName: CREATOR.name,
          ownershipType: 'PLATFORM_DIRECT',
          infraProvider: 'runpod',
          provider: 'runpod',
          complianceStatus: 'approved',
          moderationStatus: 'active',
          published: p.published !== false,
          license: 'Platform managed GPU / endpoint access',
          termsSummary: 'Platform Direct. The GPU infrastructure provider is not a third-party seller.',
          coverUrl: p.coverUrl,
          gallery,
          pricing: p.pricing,
          runtime,
          tags: p.tags,
          apiDocsMarkdown: p.apiDocsMarkdown,
          changelog: p.changelog,
          featured: p.featured && p.published !== false,
          publishedAt: new Date(p.publishedAt),
        },
        $setOnInsert: {
          slug: p.slug,
          rating: p.rating,
          reviewCount: p.reviewCount,
          salesCount: 0,
        },
      },
      { upsert: true, new: true }
    );
    upserted += 1;
  }

  deleteCachePattern('products:*').catch(() => {});
  deleteCachePattern('creators:*').catch(() => {});
  console.log(`[aimarkets] ensured ${upserted} gateway products in marketplace`);
  return upserted;
}

module.exports = { ensureRunpodMarketplaceProducts, migrateLegacyCatalogSlugs };
