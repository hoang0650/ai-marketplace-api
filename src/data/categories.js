/** Keep in sync with ai-marketplace/src/app/models/categories.ts — AI marketplace only. */

const AI_CATEGORIES = [
  { id: 'text-to-text', label: 'Text to Text', description: 'LLMs, chat, embeddings, and reasoning models.', hubPath: '/text-to-text', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'text-to-image', label: 'Text to Image', description: 'Create images from text prompts.', hubPath: '/text-to-image', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'image-to-image', label: 'Image to Image', description: 'Edit, restyle, or transform existing images.', hubPath: '/image-to-image', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'text-to-video', label: 'Text to Video', description: 'Generate video from a text prompt.', hubPath: '/text-to-video', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'image-to-video', label: 'Image to Video', description: 'Animate a reference image with a prompt.', hubPath: '/image-to-video', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'api-endpoint', label: 'Sell API', description: 'Metered OpenAI-compatible APIs for buyers.', hubPath: '/api-endpoint', group: 'apis', navGroup: 'apis', lane: 'ai' },
  { id: 'inference', label: 'Inference', description: 'Hosted inference endpoints and GPU runtimes.', hubPath: '/inference', group: 'apis', navGroup: 'apis', lane: 'ai' },
  { id: 'gpu-compute', label: 'GPU compute', description: 'Rent GPU by the hour from any registered provider.', hubPath: '/gpu-compute', group: 'apis', navGroup: 'platform', lane: 'ai' },
  { id: 'game-server', label: 'Game server', description: 'GPU game servers and live streams.', hubPath: '/game-server', group: 'apis', navGroup: 'platform', lane: 'ai' },
  { id: 'training-service', label: 'Training', description: 'Fine-tune and training jobs on provider GPUs.', hubPath: '/training-service', group: 'models', navGroup: 'platform', lane: 'ai' },
  { id: 'agent-runtime', label: 'Agent runtime', description: 'Deploy open-source agents as containers (OpenClaw, Hermes, custom).', hubPath: '/agent-runtime', group: 'hire', navGroup: 'platform', lane: 'ai' },
  { id: 'dataset', label: 'Dataset', description: 'Curated datasets for training and evaluation.', hubPath: '/dataset', group: 'models', navGroup: 'platform', lane: 'ai' },
  { id: 'skill-pack', label: 'Skill packs', description: 'Buy & sell OpenClaw / agent skill bundles (SKILL.md + tools).', hubPath: '/skill-pack', group: 'skills', navGroup: 'platform', lane: 'ai' },
  { id: 'hire-agent', label: 'Agents', description: 'Hire & launch OpenClaw agents.', hubPath: '/hire-agent', group: 'hire', navGroup: 'platform', lane: 'ai' },
  { id: 'hire-marketing', label: 'Marketing', description: 'Hire marketers for campaigns, ads, and growth.', hubPath: '/hire-marketing', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-seo', label: 'SEO', description: 'Hire SEO specialists for search growth.', hubPath: '/hire-seo', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-creator', label: 'Creator', description: 'Hire content creators, editors, and UGC talent.', hubPath: '/hire-creator', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-workflow', label: 'Workflow automation', description: 'Hire specialists to automate ops with n8n, Zapier, Make, OpenClaw.', hubPath: '/hire-workflow', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-build-app', label: 'Build app', description: 'Hire teams to design and ship mobile / desktop apps.', hubPath: '/hire-build-app', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-build-web', label: 'Build web', description: 'Hire teams to build marketing sites, dashboards, and web apps.', hubPath: '/hire-build-web', group: 'hire', navGroup: 'talent', lane: 'ai' },
];

const DIGITAL_CATEGORIES = [];
const CATEGORY_META = [...AI_CATEGORIES];
const PRODUCT_CATEGORIES = CATEGORY_META.map((c) => c.id);

module.exports = {
  AI_CATEGORIES,
  DIGITAL_CATEGORIES,
  CATEGORY_META,
  PRODUCT_CATEGORIES,
};
