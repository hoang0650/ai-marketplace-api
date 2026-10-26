const { seedPasswordHash } = require('./seed-password');
const User = require('../models/User');
const Product = require('../models/Product');
const GpuServer = require('../models/GpuServer');
const { CREATOR, buildComputeTestProducts, RETIRED_GAME_SLUGS, RETIRED_GPU_SLUGS } = require('../data/compute-test-products');
const { buildGameServerProducts } = require('../data/game-server-products');
const { deleteCachePattern } = require('./cache');
const { gpuRentalConfig } = require('./gpu-rental/config');

async function ensureCreator() {
  let creator =
    (await User.findOne({ creatorSlug: CREATOR.creatorSlug })) ||
    (await User.findOne({ email: CREATOR.email }));
  if (!creator) {
    creator = await User.create({
      email: CREATOR.email,
      passwordHash: await seedPasswordHash(),
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
          streaming: {
            devices: listing.streaming?.devices || ['pc', 'mobile'],
            rentalOfferId: listing.streaming?.rentalOfferId || '',
          },
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
          devices: listing.streaming?.devices || ['pc', 'mobile'],
          maxConcurrent: 20,
        },
      },
      { upsert: true, new: true },
    );
    nodes += 1;
  }

  // Retired sandbox game demos stay in the DB (past sessions reference them) but are hidden.
  const retired = await Product.updateMany(
    { slug: { $in: RETIRED_GAME_SLUGS }, published: true },
    { $set: { published: false, featured: false } },
  );
  // Retired static GPU listings: delete outright so /product/<slug> 404s and they leave /marketplace.
  const goneGpu = await Product.deleteMany({ slug: { $in: RETIRED_GPU_SLUGS }, creatorSlug: CREATOR.creatorSlug });
  await GpuServer.deleteMany({ providerServerId: { $in: RETIRED_GPU_SLUGS.map((s) => `testnode-${s}`) } });
  const games = await ensureGameServerProducts(creator);

  deleteCachePattern('products:*').catch(() => {});
  console.log(
    `[compute-test] ensured ${products} listings, ${nodes} sandbox nodes, ${games} game servers; unpublished ${retired.modifiedCount || 0} retired demos, removed ${goneGpu.deletedCount || 0} retired GPU listings`,
  );
  return { products, nodes, games };
}

/** Dedicated game-server listings (no static node: each session launches its own pod). */
async function ensureGameServerProducts(creator) {
  let n = 0;
  for (const listing of buildGameServerProducts()) {
    await Product.findOneAndUpdate(
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
          license: 'Máy chủ do AI Markets vận hành; phần mềm game theo giấy phép của nhà phát hành',
          termsSummary:
            `Mỗi phiên là một máy chủ riêng, tính phí theo phút từ khi sẵn sàng (chi phí thực gồm lưu trữ + ${Math.round(gpuRentalConfig().markup * 100)}%). Dừng phiên sẽ xoá máy chủ và dữ liệu thế giới.`,
          coverUrl: listing.coverUrl,
          gallery: listing.gallery,
          pricing: listing.pricing,
          tags: listing.tags,
          apiDocsMarkdown: listing.apiDocsMarkdown,
          changelog: listing.changelog,
          featured: listing.featured,
          productType: listing.productType,
          taxCategory: listing.taxCategory,
          streaming: listing.streaming,
          gameServer: listing.gameServer,
          publishedAt: new Date('2026-10-25T00:00:00.000Z'),
        },
        $setOnInsert: { slug: listing.slug, rating: listing.rating, reviewCount: listing.reviewCount, salesCount: 0 },
      },
      { upsert: true, new: true },
    );
    n += 1;
  }
  return n;
}

module.exports = { ensureComputeTestProducts, ensureGameServerProducts };
