const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Product = require('../models/Product');
const GpuServer = require('../models/GpuServer');
const { CREATOR, buildComputeTestProducts } = require('../data/compute-test-products');
const { deleteCachePattern } = require('./cache');

async function ensureCreator() {
  let creator =
    (await User.findOne({ creatorSlug: CREATOR.creatorSlug })) ||
    (await User.findOne({ email: CREATOR.email }));
  if (!creator) {
    creator = await User.create({
      email: CREATOR.email,
      passwordHash: await bcrypt.hash('password', 10),
      name: CREATOR.name,
      role: 'seller',
      creatorSlug: CREATOR.creatorSlug,
      bio: CREATOR.bio,
      avatarUrl: CREATOR.avatarUrl,
      coverUrl: CREATOR.coverUrl,
      verified: true,
      affiliateCode: 'PHAI-AIMARKETS',
    });
    console.log('[compute-test] created creator', CREATOR.creatorSlug);
  }
  return creator;
}

async function ensureComputeTestProducts() {
  const creator = await ensureCreator();
  const rows = buildComputeTestProducts();
  let products = 0;
  let nodes = 0;

  for (const p of rows) {
    const { node, ...listing } = p;
    const product = await Product.findOneAndUpdate(
      { slug: listing.slug },
      {
        $set: {
          name: listing.name,
          tagline: listing.tagline,
          description: listing.description,
          category: listing.category,
          creator: creator._id,
          creatorSlug: CREATOR.creatorSlug,
          creatorName: CREATOR.name,
          ownershipType: 'PLATFORM_DIRECT',
          infraProvider: 'runpod',
          provider: 'runpod',
          complianceStatus: 'approved',
          moderationStatus: 'active',
          published: true,
          license: 'Platform managed GPU / game stream access',
          termsSummary:
            'Demo listing. GPU compute opens a terminal; game-server opens a D-pad stream until a live node is attached. Usage billed from wallet when pricing.model is usage.',
          coverUrl: listing.coverUrl,
          gallery: listing.gallery,
          pricing: listing.pricing,
          tags: listing.tags,
          apiDocsMarkdown: listing.apiDocsMarkdown,
          changelog: listing.changelog,
          featured: listing.featured,
          productType: listing.productType,
          taxCategory: listing.taxCategory,
          publishedAt: new Date('2026-09-15T00:00:00.000Z'),
        },
        $setOnInsert: {
          slug: listing.slug,
          rating: listing.rating,
          reviewCount: listing.reviewCount,
          salesCount: 0,
        },
      },
      { upsert: true, new: true },
    );
    products += 1;

    await GpuServer.findOneAndUpdate(
      { providerServerId: node.providerServerId },
      {
        $set: {
          owner: creator._id,
          projectId: 'marketplace',
          name: node.name,
          provider: 'external',
          providerServerId: node.providerServerId,
          kind: node.kind,
          status: 'online',
          gpu: node.gpu,
          product: product._id,
          external: true,
          streamKind: node.kind === 'game' ? 'sandbox' : 'terminal',
          streamHost: '',
          streamPort: 0,
          streamPath: '/',
          streamTls: false,
          region: 'test',
          maxConcurrent: 20,
        },
      },
      { upsert: true, new: true },
    );
    nodes += 1;
  }

  deleteCachePattern('products:*').catch(() => {});
  console.log(`[compute-test] ensured ${products} listings, ${nodes} sandbox nodes`);
  return { products, nodes };
}

module.exports = { ensureComputeTestProducts };
