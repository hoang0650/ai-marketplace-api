/** Keep in sync with ai-marketplace/src/app/models/categories.ts — AI marketplace only. */

const AI_CATEGORIES = [
  { id: 'text-to-text', label: 'Text to Text', description: 'LLMs, chat, embeddings, and reasoning models.', hubPath: '/text-to-text', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'text-to-image', label: 'Text to Image', description: 'Create images from text prompts.', hubPath: '/text-to-image', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'image-to-image', label: 'Image to Image', description: 'Edit, restyle, or transform existing images.', hubPath: '/image-to-image', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'text-to-video', label: 'Text to Video', description: 'Generate video from a text prompt.', hubPath: '/text-to-video', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'image-to-video', label: 'Image to Video', description: 'Animate a reference image with a prompt.', hubPath: '/image-to-video', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'voice-clone', label: 'Voice clone', description: 'Seller uploads an .mp3; VieNeu clones that voice. Buyers pay per character and/or day / month / year license. STT uses PhoWhisper-large.', hubPath: '/voice-clone', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'voice-preset', label: 'Voice presets', description: 'AI Markets sells VieNeu preset voices directly. Same billing: per character and/or day / month / year license. STT uses PhoWhisper-large.', hubPath: '/voice-preset', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'ai-film-series', label: 'Watch AI films', description: 'Watch multi-episode AI films. Access is unlocked with a day / month / year license key.', hubPath: '/ai-film-series', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'story-book', label: 'Stories & books', description: 'AI story and audiobook reading with a time-bound license key.', hubPath: '/story-book', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'skill-pack', label: 'Skill packs', description: 'Download OpenClaw / agent skill bundles. Unlocked with a day / month / year license key.', hubPath: '/skill-pack', group: 'skills', navGroup: 'generate', lane: 'ai' },
  { id: 'dataset', label: 'Dataset', description: 'Download training and evaluation datasets. Unlocked with a day / month / year license key.', hubPath: '/dataset', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'api-endpoint', label: 'Sell API', description: 'Metered OpenAI-compatible APIs for buyers.', hubPath: '/api-endpoint', group: 'apis', navGroup: 'apis', lane: 'ai' },
  { id: 'inference', label: 'Inference', description: 'Hosted inference endpoints and GPU runtimes.', hubPath: '/inference', group: 'apis', navGroup: 'apis', lane: 'ai' },
  { id: 'gpu-compute', label: 'GPU compute', description: 'Rent GPU by the hour from any registered provider.', hubPath: '/gpu-compute', group: 'apis', navGroup: 'platform', lane: 'ai' },
  { id: 'game-server', label: 'Game server', description: 'GPU game servers and live streams.', hubPath: '/game-server', group: 'apis', navGroup: 'platform', lane: 'ai' },
  { id: 'training-service', label: 'Training', description: 'Fine-tune and training jobs on provider GPUs.', hubPath: '/training-service', group: 'models', navGroup: 'platform', lane: 'ai' },
  { id: 'agent-runtime', label: 'Agent runtime', description: 'Deploy open-source agents as containers (OpenClaw, Hermes, custom).', hubPath: '/agent-runtime', group: 'hire', navGroup: 'platform', lane: 'ai' },
  { id: 'hire-agent', label: 'Agents', description: 'Hire & launch OpenClaw agents.', hubPath: '/hire-agent', group: 'hire', navGroup: 'platform', lane: 'ai' },
  // Professional services (Quy chế 2.1, khoản 6 Mục X): fixed-package, outcome-based services sold
  // like any other product. Ids keep the legacy `hire-*` prefix so existing listings/orders stay valid.
  { id: 'hire-marketing', label: 'Marketing', description: 'Fixed-package marketing services (campaigns, ads, growth) priced per deliverable.', hubPath: '/hire-marketing', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-seo', label: 'SEO', description: 'Fixed-package SEO services priced per deliverable.', hubPath: '/hire-seo', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-creator', label: 'Creator', description: 'Fixed-package content creation (video, design, copy) priced per deliverable.', hubPath: '/hire-creator', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-workflow', label: 'Workflow automation', description: 'Fixed-package automation (n8n, Zapier, Make, OpenClaw) priced per deliverable.', hubPath: '/hire-workflow', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-build-app', label: 'Build app', description: 'Fixed-package mobile / desktop app builds priced per deliverable.', hubPath: '/hire-build-app', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-build-web', label: 'Build web', description: 'Fixed-package websites, dashboards and web apps priced per deliverable.', hubPath: '/hire-build-web', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'template-web', label: 'Web templates', description: 'Seller-made website templates. Open one in AI App Builder and restyle it with your own AI key.', hubPath: '/template-web', group: 'models', navGroup: 'platform', lane: 'ai' },
  { id: 'template-app', label: 'App templates', description: 'Seller-made React Native app templates. Run them in the phone simulator and customise with AI.', hubPath: '/template-app', group: 'models', navGroup: 'platform', lane: 'ai' },
];

/** Builder template listings → project kind. */
const TEMPLATE_CATEGORY_KIND = { 'template-web': 'web', 'template-app': 'app' };

/**
 * Professional services: làm web, làm app, marketing, SEO, creator, tự động hóa.
 * Sold as fixed packages and paid from the wallet at checkout like any other product
 * (no quotes, hourly/monthly pricing, job posts or milestones). Talent accounts may list only these.
 */
const PROFESSIONAL_SERVICE_CATEGORIES = [
  'hire-build-web',
  'hire-build-app',
  'hire-marketing',
  'hire-seo',
  'hire-creator',
  'hire-workflow',
];
/** @deprecated Legacy name kept for existing imports — same list as PROFESSIONAL_SERVICE_CATEGORIES. */
const HIRE_REQUEST_CATEGORIES = PROFESSIONAL_SERVICE_CATEGORIES;

const DIGITAL_CATEGORIES = [];
const CATEGORY_META = [...AI_CATEGORIES];
const PRODUCT_CATEGORIES = CATEGORY_META.map((c) => c.id);

module.exports = {
  AI_CATEGORIES,
  DIGITAL_CATEGORIES,
  CATEGORY_META,
  PRODUCT_CATEGORIES,
  TEMPLATE_CATEGORY_KIND,
  PROFESSIONAL_SERVICE_CATEGORIES,
  HIRE_REQUEST_CATEGORIES,
};
