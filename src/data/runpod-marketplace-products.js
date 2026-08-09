/**
 * Catalog models exposed as marketplace products.
 * Buyer-facing URLs are white-labeled (api.aimarkets.vn / ai.aimarkets.vn);
 * upstream provider hosts are kept only in UPSTREAM_* env for server routing.
 */
const catalog = require('./runpod-public-endpoints.json');
const { publicGatewayUrls, withUpstreamEnv } = require('../utils/gateway-urls');

const CREATOR = {
  mockUserId: 'u-runpod',
  mockCreatorId: 'c-runpod',
  email: 'models@aimarkets.vn',
  name: 'AI Markets Models',
  creatorSlug: 'aimarkets',
  bio: 'Hosted model endpoints on AI Markets — call via api.aimarkets.vn with your marketplace API key.',
  avatarUrl: 'https://api.dicebear.com/9.x/shapes/svg?seed=aimarkets',
  coverUrl: 'https://images.unsplash.com/photo-1639322537504-6427a16b0a28?w=1600&q=80',
};

const COVER_BY_KIND = {
  image: 'https://images.unsplash.com/photo-1547658719-da2b51169166?w=1200&q=80',
  video: 'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=1200&q=80',
  text: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1200&q=80',
  audio: 'https://images.unsplash.com/photo-1511379938547-c1f69419868d?w=1200&q=80',
};

const FEATURED = new Set([
  'flux-schnell',
  'flux-dev',
  'qwen3-32b',
  'moonshot-kimi',
  'wan-2-5',
  'kling-v2-1',
  'sora-2',
  'seedream-4-t2i',
]);

function usageUnitFromPricing(pricing, kind) {
  const p = String(pricing || '').toLowerCase();
  if (p.includes('megapixel')) return 'megapixel';
  if (p.includes('1m token') || p.includes('tokens')) return '1M tokens';
  if (p.includes('1k char')) return '1K chars';
  if (p.includes('/second') || p.includes('per second') || p.includes('/s')) return 'second';
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'second';
  return 'request';
}

function usageRateFromPricing(pricing) {
  const m = String(pricing || '').match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : 0;
}

function productSlug(epSlug) {
  return `runpod-${epSlug}`;
}

function buildApiDocs(ep) {
  const g = publicGatewayUrls({ modelId: ep.slug });
  const openai = `\n\n### OpenAI-compatible\n\n\`\`\`bash\ncurl ${g.gatewayUrl}/chat/completions \\\\\n  -H "Authorization: Bearer $MARKETPLACE_JWT" \\\\\n  -H "Content-Type: application/json" \\\\\n  -d '{"model":"${ep.openaiModel || ep.slug}","messages":[{"role":"user","content":"Hello"}]'}\n\`\`\`\n`;
  return `## ${ep.name}

Hosted on **AI Markets** (\`api.aimarkets.vn\` / \`ai.aimarkets.vn\`).

- **Sync:** \`POST ${g.publicEndpoint}\`
- **Async:** \`POST ${g.serverlessEndpoint}\`
- **Tokenize:** \`POST ${g.tokenizeEndpoint}\`
- **Pricing:** ${ep.pricing}

Prefer marketplace playground / \`POST /api/playground/run\` with your JWT (recommended).

\`\`\`bash
curl -X POST "https://api.aimarkets.vn/api/playground/run" \\
  -H "Authorization: Bearer $MARKETPLACE_JWT" \\
  -H "Content-Type: application/json" \\
  -d '{"productSlug":"runpod-${ep.slug}","input":{"prompt":"A serene mountain landscape"}}'
\`\`\`
${openai}`;
}

/** Mock/API-agnostic product shape (matches marketplace.json products). */
function buildRunpodMarketplaceProducts() {
  return catalog.map((ep, index) => {
    const cover = COVER_BY_KIND[ep.kind] || COVER_BY_KIND.image;
    const usageUnit = usageUnitFromPricing(ep.pricing, ep.kind);
    const usageRate = usageRateFromPricing(ep.pricing);
    return {
      id: `p-runpod-${ep.slug}`,
      slug: productSlug(ep.slug),
      name: ep.name,
      tagline: `${ep.pricing} · AI Markets endpoint`,
      description: `${ep.description} Available on AI Markets via \`api.aimarkets.vn\` (model \`${ep.slug}\`).`,
      category: ep.modality,
      creatorId: CREATOR.mockCreatorId,
      creatorSlug: CREATOR.creatorSlug,
      creatorName: CREATOR.name,
      coverUrl: cover,
      gallery: [cover],
      pricing: {
        model: 'usage',
        price: 0,
        currency: 'USD',
        usageUnit,
        usageRate,
      },
      runtime: (() => {
        const g = publicGatewayUrls({ modelId: ep.slug });
        return {
          publicEndpoint: g.publicEndpoint,
          serverlessEndpoint: g.serverlessEndpoint,
          tokenizeEndpoint: g.tokenizeEndpoint,
          gatewayUrl: g.gatewayUrl,
          env: withUpstreamEnv([{ key: 'MARKETPLACE_API_KEY', value: '' }], {
            runsync: ep.runsyncUrl,
            run: ep.runUrl,
            gateway: ep.openaiBaseUrl || '',
            endpointId: ep.endpointId,
            provider: 'runpod_public',
          }),
          envKeys: ['MARKETPLACE_API_KEY', 'UPSTREAM_RUNSYNC', 'UPSTREAM_RUN', 'PROVIDER_ENDPOINT_ID', 'AI_PROVIDER'],
          skills: [],
          baseModel: ep.openaiModel || ep.name,
          systemPrompt: '',
          temperature: 0.7,
          maxTokens: 1024,
        };
      })(),
      rating: 4.6,
      reviewCount: 12 + (index % 40),
      installCount: 800 + index * 37,
      tags: [
        'aimarkets',
        'public-endpoint',
        ep.kind,
        ep.modality,
        ep.endpointId,
      ],
      apiDocsMarkdown: buildApiDocs(ep),
      changelog: [
        {
          version: '1.0.0',
          date: '2026-08-09',
          notes: 'Listed on AI Markets gateway (api.aimarkets.vn).',
        },
      ],
      featured: FEATURED.has(ep.slug),
      publishedAt: '2026-08-09T00:00:00.000Z',
    };
  });
}

function buildRunpodCreator() {
  return {
    id: CREATOR.mockCreatorId,
    slug: CREATOR.creatorSlug,
    name: CREATOR.name,
    bio: CREATOR.bio,
    avatarUrl: CREATOR.avatarUrl,
    coverUrl: CREATOR.coverUrl,
    verified: true,
    productCount: catalog.length,
    rating: 4.9,
    totalSales: 50000,
  };
}

function buildRunpodUser() {
  return {
    id: CREATOR.mockUserId,
    email: CREATOR.email,
    name: CREATOR.name,
    role: 'creator',
    creatorSlug: CREATOR.creatorSlug,
    bio: CREATOR.bio,
    avatarUrl: CREATOR.avatarUrl,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

module.exports = {
  CREATOR,
  buildRunpodMarketplaceProducts,
  buildRunpodCreator,
  buildRunpodUser,
  productSlug,
};
