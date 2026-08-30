const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Product = require('../models/Product');
const { publicGatewayUrls, withUpstreamEnv } = require('./gateway-urls');
const { deleteCachePattern } = require('./cache');

const CREATOR = {
  email: 'providers@aimarkets.vn',
  name: 'PH AI Gateways',
  creatorSlug: 'phai-gateways',
  bio: 'OpenRouter, Featherless, and metered inference APIs on PH AI Market.',
  avatarUrl: '/assets/brand/ph-mark.svg',
  coverUrl: '/assets/brand/cover-ai.svg',
};

const CATALOG = [
  {
    slug: 'openrouter-gpt-4o-mini',
    name: 'OpenRouter · GPT-4o mini',
    tagline: 'Routed OpenAI GPT-4o mini — keys stay on the server.',
    category: 'inference',
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    tags: ['openrouter', 'text-to-text', 'api'],
    featured: true,
    usageRate: 0.15,
  },
  {
    slug: 'openrouter-claude-sonnet',
    name: 'OpenRouter · Claude Sonnet',
    tagline: 'Anthropic Claude via OpenRouter routing.',
    category: 'inference',
    provider: 'openrouter',
    model: 'anthropic/claude-3.5-sonnet',
    tags: ['openrouter', 'text-to-text', 'api'],
    featured: true,
    usageRate: 3,
  },
  {
    slug: 'featherless-qwen25-72b',
    name: 'Featherless · Qwen2.5 72B',
    tagline: 'Open-weight chat via Featherless AI.',
    category: 'inference',
    provider: 'featherless',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    tags: ['featherless', 'text-to-text', 'api'],
    featured: true,
    usageRate: 0.4,
  },
  {
    slug: 'featherless-llama31-8b',
    name: 'Featherless · Llama 3.1 8B',
    tagline: 'Fast open-weight instruct model.',
    category: 'inference',
    provider: 'featherless',
    model: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    tags: ['featherless', 'text-to-text', 'api'],
    featured: false,
    usageRate: 0.08,
  },
  {
    slug: 'phai-inference-api',
    name: 'PH AI Inference API',
    tagline: 'OpenAI-compatible /v1/chat/completions through the marketplace edge.',
    category: 'inference',
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    tags: ['inference', 'api-endpoint', 'openai-compatible'],
    featured: true,
    usageRate: 0.2,
  },
  {
    slug: 'phai-sell-api',
    name: 'Sell your API',
    tagline: 'Meter buyer traffic; ProxVN publishes a public HTTPS URL.',
    category: 'api-endpoint',
    provider: 'featherless',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    tags: ['api-endpoint', 'sell-api'],
    featured: true,
    usageRate: 0.25,
  },
];

async function ensureAiProviderProducts() {
  let creator =
    (await User.findOne({ creatorSlug: CREATOR.creatorSlug })) ||
    (await User.findOne({ email: CREATOR.email }));

  await Product.updateMany(
    { category: { $in: ['openrouter', 'featherless', 'runpod-public'] } },
    { $set: { category: 'inference' } },
  );

  if (!creator) {
    creator = await User.create({
      email: CREATOR.email,
      passwordHash: await bcrypt.hash('password', 10),
      name: CREATOR.name,
      role: 'creator',
      creatorSlug: CREATOR.creatorSlug,
      bio: CREATOR.bio,
      avatarUrl: CREATOR.avatarUrl,
      coverUrl: CREATOR.coverUrl,
      verified: true,
      affiliateCode: 'PHAI-GATEWAYS',
    });
  }

  let upserted = 0;
  for (const row of CATALOG) {
    const urls = publicGatewayUrls({ modelId: row.slug });
    const env = withUpstreamEnv([], {
      provider: row.provider,
      endpointId: row.model,
      gateway: row.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.featherless.ai/v1',
    });
    await Product.findOneAndUpdate(
      { slug: row.slug },
      {
        $set: {
          name: row.name,
          tagline: row.tagline,
          description: `${row.tagline}\n\nCalls go Frontend → Node → denglish-api → ${row.provider}. Provider keys never reach the browser.`,
          category: row.category,
          creator: creator._id,
          creatorSlug: CREATOR.creatorSlug,
          creatorName: CREATOR.name,
          coverUrl: '/assets/brand/cover-ai.svg',
          gallery: [],
          pricing: {
            model: 'usage',
            price: 0,
            currency: 'USD',
            usageUnit: 'tokens',
            usageRate: row.usageRate,
          },
          runtime: {
            ...urls,
            env,
            skills: [],
            baseModel: row.model,
            systemPrompt: '',
            temperature: 0.7,
            maxTokens: 2048,
          },
          tags: row.tags,
          apiDocsMarkdown: `POST /api/playground/run with productSlug \`${row.slug}\`.`,
          featured: row.featured,
          publishedAt: new Date(),
        },
        $setOnInsert: { slug: row.slug, rating: 4.8, reviewCount: 12, salesCount: 0 },
      },
      { upsert: true }
    );
    upserted += 1;
  }
  deleteCachePattern('products:*').catch(() => {});
  console.log(`[aimarkets] ensured ${upserted} OpenRouter/Featherless/API products`);
  return upserted;
}

module.exports = { ensureAiProviderProducts };
