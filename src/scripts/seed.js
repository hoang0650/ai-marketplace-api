/**
 * Seed MongoDB from ai-marketplace mock JSON.
 * Usage: npm run seed
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../config/env');
const User = require('../models/User');
const Product = require('../models/Product');
const Review = require('../models/Review');
const Order = require('../models/Order');
const WalletTx = require('../models/WalletTx');
const Notification = require('../models/Notification');
const UsageStat = require('../models/UsageStat');
const Deployment = require('../models/Deployment');
const UsageEvent = require('../models/UsageEvent');
const {
  CREATOR: RUNPOD_CREATOR,
  buildRunpodMarketplaceProducts,
  buildRunpodUser,
  buildRunpodCreator,
} = require('../data/runpod-marketplace-products');

const MOCK_PATH = path.resolve(
  __dirname,
  '../../../ai-marketplace/src/assets/mock/marketplace.json'
);

async function seed() {
  if (!fs.existsSync(MOCK_PATH)) {
    throw new Error(`Mock file not found: ${MOCK_PATH}`);
  }
  const mock = JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
  // Attach official RunPod Public Endpoints as marketplace listings.
  const runpodUser = buildRunpodUser();
  const runpodCreator = buildRunpodCreator();
  if (!mock.users.some((u) => u.id === runpodUser.id || u.email === runpodUser.email)) {
    mock.users.push(runpodUser);
  }
  if (!mock.creators.some((c) => c.slug === runpodCreator.slug)) {
    mock.creators.push(runpodCreator);
  }
  const runpodProducts = buildRunpodMarketplaceProducts();
  const existingSlugs = new Set(mock.products.map((p) => p.slug));
  for (const p of runpodProducts) {
    if (!existingSlugs.has(p.slug)) mock.products.push(p);
  }

  await mongoose.connect(config.mongoUri);
  console.log('[seed] connected', config.mongoUri);
  console.log(`[seed] products including RunPod public endpoints: ${mock.products.length}`);

  await Promise.all([
    User.deleteMany({}),
    Product.deleteMany({}),
    Review.deleteMany({}),
    Order.deleteMany({}),
    WalletTx.deleteMany({}),
    Notification.deleteMany({}),
    UsageStat.deleteMany({}),
    Deployment.deleteMany({}),
    UsageEvent.deleteMany({}),
  ]);

  const passwordHash = await bcrypt.hash('password', 10);
  const creatorByMockId = new Map();
  const userByMockId = new Map();
  const productByMockId = new Map();

  // Map creator mock id -> user (creator accounts)
  const creatorsBySlug = new Map((mock.creators || []).map((c) => [c.slug, c]));

  for (const u of mock.users || []) {
    const profile = u.creatorSlug ? creatorsBySlug.get(u.creatorSlug) : null;
    const user = await User.create({
      email: u.email,
      passwordHash,
      name: u.name,
      avatarUrl: u.avatarUrl || profile?.avatarUrl || '',
      role: u.role,
      creatorSlug: u.creatorSlug || undefined,
      bio: u.bio || profile?.bio || '',
      coverUrl: profile?.coverUrl || '',
      verified: !!profile?.verified,
      affiliateCode: `PHAI-${(u.name || 'USER').replace(/\s+/g, '').slice(0, 8).toUpperCase()}`,
      affiliateClicks: mock.affiliate?.clicks || 120,
      affiliateConversions: mock.affiliate?.conversions || 8,
      affiliateEarnings: mock.affiliate?.earnings || 240,
      createdAt: u.createdAt ? new Date(u.createdAt) : undefined,
    });
    userByMockId.set(u.id, user);
    if (u.creatorSlug) {
      // also link creator store ids like c-nova
      for (const c of mock.creators || []) {
        if (c.slug === u.creatorSlug) creatorByMockId.set(c.id, user);
      }
    }
  }

  for (const p of mock.products || []) {
    const creator =
      creatorByMockId.get(p.creatorId) ||
      [...userByMockId.values()].find((u) => u.creatorSlug === p.creatorSlug);
    if (!creator) {
      console.warn('[seed] skip product without creator', p.slug);
      continue;
    }
    const slugSafe = String(p.slug || 'model').replace(/[^a-z0-9-]/gi, '-');
    const runtime = p.runtime
      ? {
          serverlessEndpoint: p.runtime.serverlessEndpoint || '',
          publicEndpoint: p.runtime.publicEndpoint || '',
          tokenizeEndpoint: p.runtime.tokenizeEndpoint || '',
          gatewayUrl: p.runtime.gatewayUrl || '',
          env: Array.isArray(p.runtime.env)
            ? p.runtime.env
            : [
                { key: 'RUNPOD_API_KEY', value: 'seed-replace-me' },
                { key: 'MODEL_ID', value: p.name },
              ],
          skills: Array.isArray(p.runtime.skills) ? p.runtime.skills : (p.tags || []).slice(0, 4),
          baseModel: p.runtime.baseModel || p.name,
          systemPrompt: p.runtime.systemPrompt || p.tagline || '',
          temperature: p.runtime.temperature ?? 0.7,
          maxTokens: p.runtime.maxTokens ?? 1024,
        }
      : {
          serverlessEndpoint: `https://api.runpod.ai/v2/${slugSafe}/runsync`,
          publicEndpoint: `https://api.runpod.ai/v2/${slugSafe}/runsync`,
          tokenizeEndpoint: '',
          gatewayUrl: p.category === 'hire-agent' ? `wss://gateway.phaimarket.com/${slugSafe}` : '',
          env: [
            { key: 'RUNPOD_API_KEY', value: 'seed-replace-me' },
            { key: 'MODEL_ID', value: p.name },
          ],
          skills: (p.tags || []).slice(0, 4),
          baseModel: p.name,
          systemPrompt: p.tagline || '',
          temperature: 0.7,
          maxTokens: 1024,
        };
    const product = await Product.create({
      slug: p.slug,
      name: p.name,
      tagline: p.tagline,
      description: p.description,
      category: p.category,
      creator: creator._id,
      creatorSlug: p.creatorSlug || creator.creatorSlug,
      creatorName: p.creatorName || creator.name,
      coverUrl: p.coverUrl,
      gallery: p.gallery || [],
      pricing: p.pricing,
      runtime,
      rating: p.rating || 0,
      reviewCount: p.reviewCount || 0,
      installCount: p.installCount || 0,
      tags: p.tags || [],
      apiDocsMarkdown: p.apiDocsMarkdown || '',
      changelog: p.changelog || [],
      featured: !!p.featured,
      publishedAt: p.publishedAt ? new Date(p.publishedAt) : new Date(),
    });
    productByMockId.set(p.id, product);
  }

  console.log(
    `[seed] RunPod Official products: ${[...productByMockId.values()].filter((p) => p.creatorSlug === RUNPOD_CREATOR.creatorSlug).length}`
  );

  for (const r of mock.reviews || []) {
    const product = productByMockId.get(r.productId);
    const user = userByMockId.get(r.userId) || userByMockId.get('u-buyer');
    if (!product || !user) continue;
    await Review.create({
      product: product._id,
      user: user._id,
      userName: r.userName || user.name,
      rating: r.rating,
      title: r.title || '',
      body: r.body || '',
      createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
    });
  }

  // Sample orders / wallet / usage / notifications for first creator
  const nova = [...userByMockId.values()].find((u) => u.email === 'nova@creators.dev');
  const buyer = userByMockId.get('u-buyer');
  const sampleProduct = [...productByMockId.values()][0];

  if (nova && buyer && sampleProduct) {
    await Order.create({
      product: sampleProduct._id,
      productName: sampleProduct.name,
      buyer: buyer._id,
      buyerName: buyer.name,
      seller: nova._id,
      amount: 29,
      currency: 'USD',
      status: 'paid',
      provider: 'stripe',
    });
    await WalletTx.create({
      user: nova._id,
      type: 'credit',
      amount: 23.2,
      currency: 'USD',
      note: `Sale: ${sampleProduct.name} (net after 20% platform fee)`,
    });
    await WalletTx.create({
      user: buyer._id,
      type: 'deposit',
      amount: 100,
      currency: 'USD',
      note: 'Buyer wallet deposit',
    });
    await WalletTx.create({
      user: buyer._id,
      type: 'deposit',
      amount: 50,
      currency: 'USD',
      note: 'Buyer wallet deposit',
    });
    await Notification.create({
      user: nova._id,
      title: 'Welcome to PH AI Market',
      body: 'Your creator dashboard is ready.',
      href: '/dashboard',
    });
  }

  // Extra paid orders across shops for admin revenue breakdown
  const orbit = [...userByMockId.values()].find((u) => u.email === 'orbit@creators.dev');
  const pulse = [...userByMockId.values()].find((u) => u.email === 'pulse@creators.dev');
  const products = [...productByMockId.values()];
  const orbitProduct = products.find((p) => String(p.creator) === String(orbit?._id)) || products[1];
  const pulseProduct = products.find((p) => String(p.creator) === String(pulse?._id)) || products[2];

  if (orbit && buyer && orbitProduct) {
    await Order.create({
      product: orbitProduct._id,
      productName: orbitProduct.name,
      buyer: buyer._id,
      buyerName: buyer.name,
      seller: orbit._id,
      amount: 49,
      currency: 'USD',
      status: 'paid',
      provider: 'paypal',
    });
    await WalletTx.create({
      user: orbit._id,
      type: 'credit',
      amount: 39.2,
      currency: 'USD',
      note: `Sale: ${orbitProduct.name} (net after 20% platform fee)`,
    });
  }

  if (pulse && buyer && pulseProduct) {
    await Order.create({
      product: pulseProduct._id,
      productName: pulseProduct.name,
      buyer: buyer._id,
      buyerName: buyer.name,
      seller: pulse._id,
      amount: 79,
      currency: 'USD',
      status: 'paid',
      provider: 'stripe',
    });
    await WalletTx.create({
      user: pulse._id,
      type: 'credit',
      amount: 63.2,
      currency: 'USD',
      note: `Sale: ${pulseProduct.name} (net after 20% platform fee)`,
    });
  }

  if (nova) {
    const days = mock.usage || [];
    for (const row of days) {
      await UsageStat.create({
        creator: nova._id,
        date: row.date,
        tokens: row.tokens || 0,
        gpuHours: row.gpuHours || 0,
        requests: row.requests || 0,
        revenue: row.revenue || 0,
      });
    }
    if (!days.length) {
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        await UsageStat.create({
          creator: nova._id,
          date: d.toISOString().slice(0, 10),
          tokens: 10000 + i * 500,
          gpuHours: 1 + i * 0.2,
          requests: 40 + i * 3,
          revenue: 12 + i,
        });
      }
    }
  }

  console.log('[seed] done');
  console.log('[seed] login with any seeded email / password: password');
  await mongoose.disconnect();
}

seed().catch(async (err) => {
  console.error('[seed] failed', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
