/**
 * Cheap test listings for the build lane — exactly one per category:
 *   hire-build-web  brand-web-rebuild   (demo listing from marketplace.json, repriced)
 *   hire-build-app  guest-app-build     (demo listing from marketplace.json, repriced)
 *   template-web    test-template-web   (files = AI Builder web demo case)
 *   template-app    test-template-app   (files = AI Builder app demo case)
 * Upserts only — nothing else is deleted. Templates belong to the seller given by --email.
 * Usage: npm run seed:builder-market -- --email=nova@creators.dev
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connectDb } = require('../config/db');
const User = require('../models/User');
const Product = require('../models/Product');
const BuilderProject = require('../models/BuilderProject');
const BuilderTemplate = require('../models/BuilderTemplate');
const files = require('../utils/builder/files');
const { applyGeneration } = require('../routes/builder');
const { WEB_CASE, APP_CASE, replayCase } = require('./builder-demo-cases');
const { inferProductType } = require('../data/marketplace-types');
const { taxCategoryFromProduct } = require('../finance/tax-category');
const { publicGatewayUrls } = require('../utils/gateway-urls');
const { fallbackVndPerUsd } = require('../config/fx');

const MOCK_PATH = path.resolve(__dirname, '../../../ai-marketplace/src/assets/mock/marketplace.json');
const VND_PER_USD = fallbackVndPerUsd();

/** USD, one-time. */
const HIRE = [
  { slug: 'brand-web-rebuild', category: 'hire-build-web', price: 5 },
  { slug: 'guest-app-build', category: 'hire-build-app', price: 8 },
];

const TEMPLATES = [
  {
    slug: 'test-template-web',
    category: 'template-web',
    kind: 'web',
    price: 1,
    demo: WEB_CASE,
    name: 'Template landing page khách sạn',
    tagline: 'Landing page 1 trang: hero, hạng phòng, form đặt phòng tự tính tiền.',
    description:
      'Template web tĩnh (HTML/CSS/JS) cho khách sạn / homestay. Mua xong mở trong AI Builder và nhờ AI đổi màu, nội dung, phong cách theo thương hiệu của bạn bằng API key riêng.',
    coverUrl: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1200&q=80',
    tags: ['template', 'web', 'landing-page', 'hotel', 'template-web'],
  },
  {
    slug: 'test-template-app',
    category: 'template-app',
    kind: 'app',
    price: 2,
    demo: APP_CASE,
    name: 'Template app đặt phòng',
    tagline: 'App React Native 2 tab: danh sách phòng và phòng đã đặt, tính tổng tiền.',
    description:
      'Template app Expo / React Native cho đặt phòng. Mua xong mở trong AI Builder, chạy thử giả lập ngay trên web và nhờ AI tuỳ biến giao diện, luồng màn hình theo ý bạn.',
    coverUrl: 'https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=1200&q=80',
    tags: ['template', 'app', 'react-native', 'hotel', 'template-app'],
  },
];

function argEmail() {
  const flag = process.argv.find((a) => a.startsWith('--email='));
  return String((flag ? flag.slice('--email='.length) : process.env.BUILDER_DEMO_EMAIL) || 'nova@creators.dev')
    .trim()
    .toLowerCase();
}

function vnd(usd) {
  return `${Math.round(usd * VND_PER_USD).toLocaleString('vi-VN')}đ`;
}

function demoFiles(demo) {
  const doc = new BuilderProject({
    owner: undefined,
    name: demo.name,
    kind: demo.kind,
    files: files.starterFiles(demo.kind),
    previewToken: crypto.randomBytes(8).toString('hex'),
  });
  replayCase(doc, demo, applyGeneration);
  return doc.files.map((f) => ({ path: f.path, content: f.content }));
}

function loadMock() {
  if (!fs.existsSync(MOCK_PATH)) return { products: [] };
  return JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
}

async function upsertHire(seller, mock) {
  const out = [];
  for (const h of HIRE) {
    const pricing = { model: 'one-time', price: h.price, currency: 'USD' };
    const existing = await Product.findOne({ slug: h.slug });
    if (existing) {
      existing.pricing = pricing;
      existing.published = true;
      existing.moderationStatus = 'active';
      await existing.save();
      out.push({ ...h, action: 'repriced', seller: existing.creatorName });
      continue;
    }
    const m = (mock.products || []).find((p) => p.slug === h.slug);
    if (!m) {
      out.push({ ...h, action: 'skipped (not in DB nor marketplace.json)' });
      continue;
    }
    const g = publicGatewayUrls({ modelId: h.slug });
    const productType = inferProductType(h.category, m.tags);
    await Product.create({
      slug: h.slug,
      name: m.name,
      tagline: m.tagline,
      description: m.description,
      category: h.category,
      creator: seller._id,
      creatorSlug: seller.creatorSlug,
      creatorName: seller.name,
      coverUrl: m.coverUrl,
      gallery: m.gallery || [],
      pricing,
      runtime: {
        serverlessEndpoint: g.serverlessEndpoint,
        publicEndpoint: g.publicEndpoint,
        tokenizeEndpoint: g.tokenizeEndpoint,
        gatewayUrl: g.gatewayUrl,
        skills: (m.tags || []).slice(0, 4),
        baseModel: m.name,
        systemPrompt: m.tagline || '',
      },
      tags: m.tags || [],
      apiDocsMarkdown: m.apiDocsMarkdown || '',
      productType,
      taxCategory: taxCategoryFromProduct({ category: h.category, productType }),
      ownershipType: 'THIRD_PARTY_SELLER',
      published: true,
      moderationStatus: 'active',
    });
    out.push({ ...h, action: 'created', seller: seller.name });
  }
  return out;
}

async function upsertTemplates(seller) {
  const out = [];
  for (const t of TEMPLATES) {
    const tplFiles = demoFiles(t.demo);
    const productType = inferProductType(t.category, t.tags);
    const product = await Product.findOneAndUpdate(
      { slug: t.slug },
      {
        $set: {
          name: t.name,
          tagline: t.tagline,
          description: t.description,
          category: t.category,
          creator: seller._id,
          creatorSlug: seller.creatorSlug,
          creatorName: seller.name,
          coverUrl: t.coverUrl,
          gallery: [t.coverUrl],
          pricing: { model: 'one-time', price: t.price, currency: 'USD' },
          tags: t.tags,
          apiDocsMarkdown: `## Bao gồm\n\n${tplFiles.map((f) => `- \`${f.path}\``).join('\n')}\n\nMở trong AI Builder sau khi mua để tuỳ biến bằng AI.`,
          productType,
          taxCategory: taxCategoryFromProduct({ category: t.category, productType }),
          ownershipType: 'THIRD_PARTY_SELLER',
          published: true,
          moderationStatus: 'active',
        },
        $setOnInsert: { publishedAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    const tpl = await BuilderTemplate.findOneAndUpdate(
      { product: product._id },
      { $set: { owner: seller._id, kind: t.kind, files: tplFiles, demoEnabled: true }, $inc: { version: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    out.push({ ...t, files: tplFiles.length, version: tpl.version });
  }
  return out;
}

async function run(email) {
  const seller = await User.findOne({ email }).select('_id email name role creatorSlug').lean();
  if (!seller) throw new Error(`Không tìm thấy user ${email}`);
  if (!seller.creatorSlug) throw new Error(`${email} chưa có creatorSlug (cần tài khoản seller)`);
  if (!['seller', 'admin'].includes(seller.role)) console.warn(`[seed:builder-market] cảnh báo: ${email} có role=${seller.role}, không phải seller`);
  const mock = loadMock();
  const hire = await upsertHire(seller, mock);
  const templates = await upsertTemplates(seller);
  return { seller, hire, templates };
}

const email = argEmail();
connectDb()
  .then(() => run(email))
  .then(({ seller, hire, templates }) => {
    console.log(`[seed:builder-market] seller=${seller.email} (${seller.creatorSlug})`);
    for (const h of hire) {
      console.log(`  ${h.category.padEnd(15)} /product/${h.slug}  $${h.price} ≈ ${vnd(h.price)}  ${h.action}${h.seller ? ` · ${h.seller}` : ''}`);
    }
    for (const t of templates) {
      console.log(`  ${t.category.padEnd(15)} /product/${t.slug}  $${t.price} ≈ ${vnd(t.price)}  ${t.files} files · v${t.version}`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('[seed:builder-market] failed', err);
    process.exit(1);
  });
