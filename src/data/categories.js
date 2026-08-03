const CATEGORY_META = [
  { id: 'text-to-text', label: 'Text to Text', description: 'LLMs, chat, embeddings, and reasoning models.', hubPath: '/text-to-text', group: 'models' },
  { id: 'text-to-video', label: 'Text to Video', description: 'Generate video from a text prompt.', hubPath: '/text-to-video', group: 'models' },
  { id: 'image-to-video', label: 'Image to Video', description: 'Animate a reference image with a prompt.', hubPath: '/image-to-video', group: 'models' },
  { id: 'text-to-image', label: 'Text to Image', description: 'Create images from text prompts.', hubPath: '/text-to-image', group: 'models' },
  { id: 'image-to-image', label: 'Image to Image', description: 'Edit, restyle, or transform existing images.', hubPath: '/image-to-image', group: 'models' },
  { id: 'fine-tune', label: 'Fine-tune', description: 'Fine-tune LLMs and vision models on your data.', hubPath: '/fine-tune', group: 'models' },
  { id: 'dataset', label: 'Dataset', description: 'Curated datasets for training and evaluation.', hubPath: '/dataset', group: 'models' },
  { id: 'inference', label: 'Inference', description: 'Hosted inference endpoints and GPU runtimes.', hubPath: '/inference', group: 'models' },
  { id: 'skill-pack', label: 'Skill packs', description: 'Buy & sell OpenClaw / agent skill bundles (SKILL.md + tools).', hubPath: '/skill-pack', group: 'skills' },
  { id: 'hire-agent', label: 'Agents', description: 'Hire & launch OpenClaw agents (Featherless-style marketplace).', hubPath: '/hire-agent', group: 'hire' },
  { id: 'hire-marketing', label: 'Marketing', description: 'Hire marketers for campaigns, ads, and growth.', hubPath: '/hire-marketing', group: 'hire' },
  { id: 'hire-seo', label: 'SEO', description: 'Hire SEO specialists for search growth.', hubPath: '/hire-seo', group: 'hire' },
  { id: 'hire-creator', label: 'Creator', description: 'Hire content creators, editors, and UGC talent.', hubPath: '/hire-creator', group: 'hire' },
  { id: 'hire-workflow', label: 'Workflow automation', description: 'Hire specialists to automate ops with n8n, Zapier, Make, OpenClaw.', hubPath: '/hire-workflow', group: 'hire' },
  { id: 'hire-build-app', label: 'Build app', description: 'Hire teams to design and ship mobile / desktop apps.', hubPath: '/hire-build-app', group: 'hire' },
  { id: 'hire-build-web', label: 'Build web', description: 'Hire teams to build marketing sites, dashboards, and web apps.', hubPath: '/hire-build-web', group: 'hire' },
];

const PRODUCT_CATEGORIES = CATEGORY_META.map((c) => c.id);

module.exports = { CATEGORY_META, PRODUCT_CATEGORIES };
