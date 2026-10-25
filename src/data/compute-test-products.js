/**
 * Demo GPU compute + game-server listings for hubs /play.
 * Sandbox nodes (no streamHost): GPU listings serve a terminal; game-server listings serve the D-pad canvas.
 */
const { inferProductType } = require('./marketplace-types');
const { taxCategoryFromProduct } = require('../finance/tax-category');
const { CREATOR } = require('./runpod-marketplace-products');

const COVER = {
  gpu: 'https://images.unsplash.com/photo-1597872200969-2b65d56bd16b?w=1400&q=80',
  train: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1400&q=80',
  infer: 'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=1400&q=80',
  game: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=1400&q=80',
  arcade: 'https://images.unsplash.com/photo-1538481199705-c7403e393d76?w=1400&q=80',
  indie: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=1400&q=80',
};

function docs(slug, kind) {
  const play = `https://aimarkets.vn/play/${slug}`;
  return `## AI Markets ${kind === 'game' ? 'game stream' : 'GPU lab'}

Hosted demo for **aimarkets.vn** / the mobile app. Buyer play goes:

\`POST /v1/game-sessions { "productSlug": "${slug}" }\`

then the player at \`${play}\`.

${kind === 'game'
    ? 'The attached test node uses a **sandbox game stream** (canvas + D-pad).'
    : 'The attached test node uses a **sandbox GPU terminal** (shell only — no D-pad).'} Replace the node with hosting \`aimarkets\` + \`gpuType\` for a real pod on \`ai.aimarkets.vn\`.
`;
}

function row(partial) {
  const productType = inferProductType(partial.category, partial.tags);
  return {
    creatorSlug: CREATOR.creatorSlug,
    creatorName: CREATOR.name,
    ownershipType: 'PLATFORM_DIRECT',
    infraProvider: 'runpod',
    provider: 'runpod',
    complianceStatus: 'approved',
    productType,
    taxCategory: taxCategoryFromProduct({ category: partial.category, productType }),
    ...partial,
  };
}

function buildComputeTestProducts() {
  return [
    row({
      slug: 'gpu-sandbox-lab',
      name: 'GPU Sandbox Lab',
      tagline: 'Free test GPU terminal — train/infer commands, no local CUDA.',
      description:
        'Listing test GPU lab. Play mở terminal (nvidia-smi, python train.py). Không có D-pad — D-pad chỉ dành cho game-server.',
      category: 'gpu-compute',
      coverUrl: COVER.gpu,
      gallery: [COVER.gpu, COVER.train],
      pricing: { model: 'free', price: 0, currency: 'USD', usageUnit: 'hour', usageRate: 0 },
      tags: ['gpu', 'sandbox', 'test', 'rtx'],
      featured: true,
      rating: 4.8,
      reviewCount: 12,
      changelog: [{ version: '1.0.0', date: '2026-09-15', notes: 'Sandbox GPU lab for Play QA.' }],
      apiDocsMarkdown: docs('gpu-sandbox-lab', 'compute'),
      node: {
        name: 'Sandbox GPU Lab',
        kind: 'compute',
        gpu: 'NVIDIA RTX 4090 (sandbox)',
        providerServerId: 'testnode-gpu-sandbox-lab',
      },
    }),
    row({
      slug: 'gpu-rtx4090-hour',
      name: 'RTX 4090 · GPU by the hour',
      tagline: 'Cloud RTX 4090 for inference, fine-tune, and desktop apps.',
      description:
        'Thuê GPU theo giờ do AI Markets vận hành. Mở workspace JupyterLab + terminal trên GPU riêng; trừ ví theo phút, tự dừng khi hết số dư.',
      category: 'gpu-compute',
      coverUrl: COVER.gpu,
      gallery: [COVER.gpu],
      pricing: { model: 'usage', price: 0, currency: 'USD', usageUnit: 'hour', usageRate: 1.89 },
      tags: ['gpu', 'rtx-4090', 'usage', 'test'],
      streaming: { devices: ['pc', 'mobile'], rentalOfferId: 'NVIDIA GeForce RTX 4090' },
      featured: true,
      rating: 4.6,
      reviewCount: 28,
      changelog: [{ version: '1.0.0', date: '2026-09-15', notes: 'Hourly RTX 4090 test SKU.' }],
      apiDocsMarkdown: docs('gpu-rtx4090-hour', 'compute'),
      node: {
        name: 'RTX 4090 test node',
        kind: 'compute',
        gpu: 'NVIDIA GeForce RTX 4090',
        providerServerId: 'testnode-gpu-rtx4090-hour',
      },
    }),
    row({
      slug: 'gpu-a100-train',
      name: 'A100 80GB · Train / fine-tune',
      tagline: 'High-VRAM box for LoRA and full-parameter jobs.',
      description:
        'GPU train từ xa do AI Markets vận hành. Workspace JupyterLab + terminal (python train.py), dữ liệu giữ trong volume; trừ ví theo phút.',
      category: 'gpu-compute',
      coverUrl: COVER.train,
      gallery: [COVER.train, COVER.infer],
      pricing: { model: 'usage', price: 0, currency: 'USD', usageUnit: 'hour', usageRate: 2.49 },
      tags: ['gpu', 'a100', 'training', 'test'],
      streaming: { devices: ['pc', 'mobile'], rentalOfferId: 'NVIDIA A100 80GB PCIe' },
      featured: false,
      rating: 4.7,
      reviewCount: 9,
      changelog: [{ version: '1.0.0', date: '2026-09-15', notes: 'A100 training SKU.' }],
      apiDocsMarkdown: docs('gpu-a100-train', 'compute'),
      node: {
        name: 'A100 train test node',
        kind: 'compute',
        gpu: 'NVIDIA A100 80GB',
        providerServerId: 'testnode-gpu-a100-train',
      },
    }),
    row({
      slug: 'gpu-l40s-infer',
      name: 'L40S · Inference box',
      tagline: 'Cheaper GPU hour for batch image / LLM infer.',
      description: 'GPU inference theo giờ do AI Markets vận hành. Workspace JupyterLab + terminal; trừ ví theo phút.',
      category: 'gpu-compute',
      coverUrl: COVER.infer,
      gallery: [COVER.infer],
      pricing: { model: 'usage', price: 0, currency: 'USD', usageUnit: 'hour', usageRate: 1.19 },
      tags: ['gpu', 'l40s', 'inference', 'test'],
      streaming: { devices: ['pc', 'mobile'], rentalOfferId: 'NVIDIA L40S' },
      featured: false,
      rating: 4.4,
      reviewCount: 6,
      changelog: [{ version: '1.0.0', date: '2026-09-15', notes: 'L40S inference SKU.' }],
      apiDocsMarkdown: docs('gpu-l40s-infer', 'compute'),
      node: {
        name: 'L40S infer test node',
        kind: 'compute',
        gpu: 'NVIDIA L40S',
        providerServerId: 'testnode-gpu-l40s-infer',
      },
    }),
  ];
}

/** Old sandbox game-stream demos: replaced by real dedicated servers (data/game-server-products.js). */
const RETIRED_GAME_SLUGS = ['game-sandbox-arcade', 'game-cloud-desktop', 'game-indie-box'];

module.exports = { CREATOR, buildComputeTestProducts, RETIRED_GAME_SLUGS };
