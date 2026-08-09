/** Keep in sync with ai-marketplace/src/app/models/categories.ts */

const AI_CATEGORIES = [
  { id: 'text-to-text', label: 'Text to Text', description: 'LLMs, chat, embeddings, and reasoning models.', hubPath: '/text-to-text', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'text-to-video', label: 'Text to Video', description: 'Generate video from a text prompt.', hubPath: '/text-to-video', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'image-to-video', label: 'Image to Video', description: 'Animate a reference image with a prompt.', hubPath: '/image-to-video', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'text-to-image', label: 'Text to Image', description: 'Create images from text prompts.', hubPath: '/text-to-image', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'image-to-image', label: 'Image to Image', description: 'Edit, restyle, or transform existing images.', hubPath: '/image-to-image', group: 'models', navGroup: 'generate', lane: 'ai' },
  { id: 'fine-tune', label: 'Fine-tune', description: 'Fine-tune LLMs and vision models on your data.', hubPath: '/fine-tune', group: 'models', navGroup: 'platform', lane: 'ai' },
  { id: 'dataset', label: 'Dataset', description: 'Curated datasets for training and evaluation.', hubPath: '/dataset', group: 'models', navGroup: 'platform', lane: 'ai' },
  { id: 'inference', label: 'Inference', description: 'Hosted inference endpoints and GPU runtimes.', hubPath: '/inference', group: 'models', navGroup: 'platform', lane: 'ai' },
  { id: 'skill-pack', label: 'Skill packs', description: 'Buy & sell OpenClaw / agent skill bundles (SKILL.md + tools).', hubPath: '/skill-pack', group: 'skills', navGroup: 'platform', lane: 'ai' },
  { id: 'hire-agent', label: 'Agents', description: 'Hire & launch OpenClaw agents (Featherless-style marketplace).', hubPath: '/hire-agent', group: 'hire', navGroup: 'platform', lane: 'ai' },
  { id: 'hire-marketing', label: 'Marketing', description: 'Hire marketers for campaigns, ads, and growth.', hubPath: '/hire-marketing', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-seo', label: 'SEO', description: 'Hire SEO specialists for search growth.', hubPath: '/hire-seo', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-creator', label: 'Creator', description: 'Hire content creators, editors, and UGC talent.', hubPath: '/hire-creator', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-workflow', label: 'Workflow automation', description: 'Hire specialists to automate ops with n8n, Zapier, Make, OpenClaw.', hubPath: '/hire-workflow', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-build-app', label: 'Build app', description: 'Hire teams to design and ship mobile / desktop apps.', hubPath: '/hire-build-app', group: 'hire', navGroup: 'talent', lane: 'ai' },
  { id: 'hire-build-web', label: 'Build web', description: 'Hire teams to build marketing sites, dashboards, and web apps.', hubPath: '/hire-build-web', group: 'hire', navGroup: 'talent', lane: 'ai' },
];

const DIGITAL_CATEGORIES = [
  { id: 'ai-account', label: 'Tài khoản AI', description: 'ChatGPT, Midjourney, Claude, CapCut Pro và tài khoản AI khác.', hubPath: '/ai-account', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'social-account', label: 'Mạng xã hội', description: 'VIA, clone, BM, TikTok, YouTube, Gmail…', hubPath: '/social-account', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'software', label: 'Phần mềm', description: 'Phần mềm bản quyền, app desktop/mobile.', hubPath: '/software', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'vpn-proxy', label: 'VPN & Proxy', description: 'VPN, proxy IPv4/IPv6, antidetect.', hubPath: '/vpn-proxy', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'license-key', label: 'Key / License', description: 'Key kích hoạt, license Windows, Office, plugin.', hubPath: '/license-key', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'course', label: 'Khóa học', description: 'Khóa học MMO, AI, marketing, automation.', hubPath: '/course', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'template', label: 'Template / Source', description: 'Template web, source code, prompt pack, script.', hubPath: '/template', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'email-domain', label: 'Email & Domain', description: 'Email aged, domain, hosting mail.', hubPath: '/email-domain', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'boost-service', label: 'Tăng tương tác', description: 'Buff like, sub, view, comment đa nền tảng.', hubPath: '/boost-service', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'mmo-tool', label: 'Tool MMO', description: 'Tool nuôi nick, auto post, scrape, tiện ích MMO.', hubPath: '/mmo-tool', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'design-asset', label: 'Thiết kế', description: 'Adobe, Canva Pro, font, asset đồ họa.', hubPath: '/design-asset', group: 'digital', navGroup: 'digital', lane: 'digital' },
  { id: 'cloud-hosting', label: 'Cloud / Hosting', description: 'VPS, cloud credit, hosting, storage.', hubPath: '/cloud-hosting', group: 'digital', navGroup: 'digital', lane: 'digital' },
];

const CATEGORY_META = [...AI_CATEGORIES, ...DIGITAL_CATEGORIES];
const PRODUCT_CATEGORIES = CATEGORY_META.map((c) => c.id);

module.exports = {
  AI_CATEGORIES,
  DIGITAL_CATEGORIES,
  CATEGORY_META,
  PRODUCT_CATEGORIES,
};
