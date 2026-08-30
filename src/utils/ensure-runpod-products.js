const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Product = require('../models/Product');
const {
  CREATOR,
  buildRunpodMarketplaceProducts,
} = require('../data/runpod-marketplace-products');
const { deleteCachePattern } = require('./cache');

/**
 * Upsert catalog model products into MongoDB with white-labeled aimarkets.vn URLs.
 */
async function ensureRunpodMarketplaceProducts() {
  let creator =
    (await User.findOne({ creatorSlug: CREATOR.creatorSlug })) ||
    (await User.findOne({ email: CREATOR.email })) ||
    (await User.findOne({ creatorSlug: 'runpod' }));

  if (!creator) {
    const passwordHash = await bcrypt.hash('password', 10);
    creator = await User.create({
      email: CREATOR.email,
      passwordHash,
      name: CREATOR.name,
      role: 'creator',
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
          coverUrl: p.coverUrl,
          gallery: p.gallery,
          pricing: p.pricing,
          runtime,
          tags: p.tags,
          apiDocsMarkdown: p.apiDocsMarkdown,
          changelog: p.changelog,
          featured: p.featured,
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

module.exports = { ensureRunpodMarketplaceProducts };
