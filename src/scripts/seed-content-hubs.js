/**
 * Upsert Voice clone / Video AI / Stories test products without wiping the DB.
 * Usage: npm run seed:hubs
 */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../config/env');
const User = require('../models/User');
const Product = require('../models/Product');
const Review = require('../models/Review');
const Order = require('../models/Order');
const LicenseKey = require('../models/LicenseKey');
const ContentEpisode = require('../models/ContentEpisode');
const {
  buildContentHubProducts,
  buildContentHubReviews,
  buildContentHubLicenseSeeds,
  buildContentHubEpisodes,
  hubProductFields,
} = require('../data/content-hub-products');
const { generateLicenseKey, expiresAtFrom } = require('../utils/license-keys');

const CREATORS = [
  {
    email: 'nova@creators.dev',
    name: 'Nova Labs',
    creatorSlug: 'nova-labs',
    role: 'creator',
    bio: 'Building production AI agents for hospitality and ops.',
  },
  {
    email: 'orbit@creators.dev',
    name: 'Orbit AI',
    creatorSlug: 'orbit-ai',
    role: 'creator',
    bio: 'Text and embedding models tuned for SEA languages.',
  },
  {
    email: 'pulse@creators.dev',
    name: 'Pulse Studio',
    creatorSlug: 'pulse-studio',
    role: 'creator',
    bio: 'Image and video generation toolkits.',
  },
];

async function ensureUser(spec, passwordHash) {
  const existing = await User.findOne({ email: spec.email });
  if (existing) return existing;
  return User.create({
    email: spec.email,
    passwordHash,
    name: spec.name,
    role: spec.role,
    creatorSlug: spec.creatorSlug,
    bio: spec.bio || '',
    avatarUrl: `https://api.dicebear.com/9.x/shapes/svg?seed=${spec.creatorSlug || spec.email}`,
    verified: spec.role === 'creator',
    affiliateCode: `PHAI-${(spec.name || 'USER').replace(/\s+/g, '').slice(0, 8).toUpperCase()}`,
  });
}

async function seedHubs() {
  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 20_000,
  });
  console.log('[seed:hubs] connected', String(config.mongoUri).replace(/\/\/.*@/, '//***@'));

  const passwordHash = await bcrypt.hash('password', 10);
  const creators = {};
  for (const spec of CREATORS) {
    creators[spec.creatorSlug] = await ensureUser(spec, passwordHash);
  }
  const buyer = await ensureUser(
    {
      email: 'buyer@example.com',
      name: 'Lan Nguyen',
      role: 'buyer',
    },
    passwordHash,
  );

  const products = buildContentHubProducts();
  const byMockId = new Map();
  let created = 0;
  let updated = 0;

  for (const p of products) {
    const creator = creators[p.creatorSlug];
    if (!creator) {
      console.warn('[seed:hubs] skip — missing creator', p.slug, p.creatorSlug);
      continue;
    }
    const fields = {
      ...hubProductFields(p),
      creator: creator._id,
      creatorSlug: creator.creatorSlug,
      creatorName: creator.name,
    };
    const existing = await Product.findOne({ slug: p.slug });
    let doc;
    if (existing) {
      Object.assign(existing, fields);
      doc = await existing.save();
      updated += 1;
    } else {
      doc = await Product.create(fields);
      created += 1;
    }
    byMockId.set(p.id, doc);
  }

  for (const r of buildContentHubReviews()) {
    const product = byMockId.get(r.productId);
    if (!product) continue;
    const already = await Review.findOne({ product: product._id, user: buyer._id });
    if (already) continue;
    await Review.create({
      product: product._id,
      user: buyer._id,
      userName: r.userName || buyer.name,
      rating: r.rating,
      title: r.title || '',
      body: r.body || '',
      createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
    });
  }

  let licenses = 0;
  for (const seed of buildContentHubLicenseSeeds()) {
    const product = await Product.findOne({ slug: seed.productSlug });
    if (!product) continue;
    const existing = await LicenseKey.findOne({ buyer: buyer._id, product: product._id });
    if (existing) continue;

    const startsAt = seed.expired
      ? new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      : new Date();
    const order = await Order.create({
      product: product._id,
      productName: product.name,
      buyer: buyer._id,
      buyerName: buyer.name,
      seller: product.creator,
      ownershipType: product.ownershipType || 'THIRD_PARTY_SELLER',
      quantity: 1,
      amount: seed.amount,
      currency: 'USD',
      unitPrice: seed.amount,
      grossAmount: seed.amount,
      status: 'paid',
      paymentStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
      paymentProvider: 'internal_ledger',
      provider: 'wallet',
      completedAt: startsAt,
      contractSnapshot: {
        productName: product.name,
        productDescription: product.description || product.tagline || '',
        sellerDisplayName: product.creatorName,
        ownershipType: product.ownershipType || 'THIRD_PARTY_SELLER',
        pricing: product.pricing,
        licenseTerm: seed.term,
      },
    });
    await LicenseKey.create({
      licenseKey: generateLicenseKey(),
      order: order._id,
      product: product._id,
      productName: product.name,
      buyer: buyer._id,
      seller: product.creator,
      category: product.category,
      term: seed.term,
      startsAt,
      expiresAt: expiresAtFrom(startsAt, seed.term),
      status: 'active',
    });
    licenses += 1;
  }

  let episodes = 0;
  for (const pack of buildContentHubEpisodes()) {
    const product = await Product.findOne({ slug: pack.productSlug });
    if (!product) continue;
    const existing = await ContentEpisode.countDocuments({ product: product._id });
    if (existing) continue;
    let i = 1;
    for (const item of pack.items) {
      await ContentEpisode.create({
        product: product._id,
        seller: product.creator,
        index: i,
        title: item.title,
        kind: item.kind,
        contentType: item.contentType || '',
        sourceUrl: item.sourceUrl,
        published: true,
      });
      i += 1;
      episodes += 1;
    }
    await Product.updateOne(
      { _id: product._id },
      { $set: { 'contentMeta.episodeCount': pack.items.length } },
    );
  }

  const counts = await Product.aggregate([
    { $match: { category: { $in: ['voice-clone', 'ai-film-series', 'story-book'] } } },
    { $group: { _id: '$category', n: { $sum: 1 } } },
  ]);
  const countMap = Object.fromEntries(counts.map((c) => [c._id, c.n]));

  console.log('[seed:hubs] products created', created, 'updated', updated);
  console.log('[seed:hubs] licenses issued', licenses);
  console.log('[seed:hubs] episodes', episodes);
  console.log('[seed:hubs] catalog', {
    'voice-clone': countMap['voice-clone'] || 0,
    'ai-film-series': countMap['ai-film-series'] || 0,
    'story-book': countMap['story-book'] || 0,
  });
  console.log('[seed:hubs] buyer login: buyer@example.com / password');
  await mongoose.disconnect();
}

seedHubs().catch(async (err) => {
  console.error('[seed:hubs] failed', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
