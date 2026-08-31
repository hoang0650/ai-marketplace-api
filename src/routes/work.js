const express = require('express');
const JobPosting = require('../models/JobPosting');
const TalentProfile = require('../models/TalentProfile');
const { authenticate } = require('../middleware/auth');
const { slugify } = require('../utils/serialize');
const { WORK_FIELDS } = require('../data/work-fields');
const { isDbReady } = require('../config/db');

const router = express.Router();

function mapJob(doc) {
  const j = doc.toJSON ? doc.toJSON() : doc;
  return {
    id: j.id || j._id?.toString(),
    slug: j.slug,
    title: j.title,
    company: j.company,
    description: j.description,
    location: j.location,
    remote: j.remote,
    fieldIds: j.fieldIds || [],
    skills: j.skills || [],
    employmentType: j.employmentType,
    salaryMin: j.salaryMin,
    salaryMax: j.salaryMax,
    salaryCurrency: j.salaryCurrency,
    salaryPeriod: j.salaryPeriod,
    salaryNegotiable: j.salaryNegotiable,
    status: j.status,
    postedBy: j.postedBy?.toString?.() || j.postedBy,
    postedByName: j.postedByName || '',
    applicationsCount: j.applicationsCount || 0,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

function mapTalent(doc) {
  const t = doc.toJSON ? doc.toJSON() : doc;
  return {
    id: t.id || t._id?.toString(),
    slug: t.slug,
    userId: t.user?.toString?.() || t.user,
    name: t.name,
    title: t.title,
    avatarUrl: t.avatarUrl || '',
    bio: t.bio || '',
    fieldIds: t.fieldIds || [],
    skills: t.skills || [],
    experienceYears: t.experienceYears || 0,
    hoursPerWeek: t.hoursPerWeek || 40,
    rateAmount: t.rateAmount || 0,
    rateCurrency: t.rateCurrency || 'VND',
    rateNegotiable: t.rateNegotiable !== false,
    available: t.available !== false,
    contractsCount: t.contractsCount || 0,
    rating: t.rating || 0,
    reviewsCount: t.reviewsCount || 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

const SEED_TALENTS = [
  {
    slug: 'dong-nguyen-dev',
    name: 'Đông Nguyễn',
    title: 'Developer · AI Automation',
    bio: 'Full-stack developer chuyên triển khai agent, workflow n8n và tích hợp API AI cho doanh nghiệp.',
    fieldIds: ['ai-automation', 'web-dev'],
    skills: ['Angular', 'Node.js', 'OpenClaw', 'n8n', 'MongoDB'],
    experienceYears: 3,
    hoursPerWeek: 40,
    rateAmount: 50000,
    rateCurrency: 'VND',
    rateNegotiable: false,
    available: true,
  },
  {
    slug: 'pham-nhu-thanh',
    name: 'Phạm Như Thành',
    title: 'Business · Growth',
    bio: 'Chuyên gia tăng trưởng B2B SaaS, chiến dịch performance marketing và funnel AI products.',
    fieldIds: ['marketing', 'sales'],
    skills: ['Google Ads', 'SEO', 'CRM', 'Analytics'],
    experienceYears: 5,
    hoursPerWeek: 30,
    rateNegotiable: true,
    available: true,
  },
  {
    slug: 'linh-tran-ai',
    name: 'Linh Trần',
    title: 'AI Content Specialist',
    bio: 'Sản xuất nội dung đa kênh với LLM, prompt engineering và brand voice cho startup AI.',
    fieldIds: ['ai-content', 'marketing'],
    skills: ['GPT', 'Claude', 'Copywriting', 'Social Media'],
    experienceYears: 2,
    hoursPerWeek: 25,
    rateAmount: 45000,
    rateCurrency: 'VND',
    available: true,
  },
  {
    slug: 'minh-le-devops',
    name: 'Minh Lê',
    title: 'DevOps Engineer',
    bio: 'Triển khai GPU runtime, Docker, CI/CD cho marketplace AI và inference endpoints.',
    fieldIds: ['devops', 'ai-integration'],
    skills: ['Docker', 'Kubernetes', 'RunPod', 'AWS', 'Terraform'],
    experienceYears: 4,
    hoursPerWeek: 40,
    rateAmount: 80000,
    rateCurrency: 'VND',
    available: true,
  },
  {
    slug: 'ha-vu-design',
    name: 'Hà Vũ',
    title: 'UI/UX Designer',
    bio: 'Thiết kế dashboard AI, design system và landing page cho sản phẩm B2B.',
    fieldIds: ['ui-ux', 'product-design'],
    skills: ['Figma', 'Design System', 'Prototyping'],
    experienceYears: 3,
    hoursPerWeek: 35,
    rateNegotiable: true,
    available: true,
  },
  {
    slug: 'khoa-pham-data',
    name: 'Khoa Phạm',
    title: 'Data Labeling Lead',
    bio: 'Quản lý pipeline gán nhãn dữ liệu cho fine-tune LLM và vision models.',
    fieldIds: ['data-labeling', 'data-analytics'],
    skills: ['Python', 'Label Studio', 'QA', 'Excel'],
    experienceYears: 2,
    hoursPerWeek: 40,
    rateAmount: 35000,
    rateCurrency: 'VND',
    available: true,
  },
];

const SEED_JOBS = [
  {
    slug: 'senior-ai-engineer-remote',
    title: 'Senior AI Engineer (Remote)',
    company: 'AI Markets Partner',
    description:
      'Tìm kỹ sư AI triển khai inference endpoints, tối ưu latency và tích hợp OpenAI-compatible gateway.',
    location: 'Remote · Việt Nam',
    remote: true,
    fieldIds: ['ai-integration', 'devops'],
    skills: ['Python', 'Node.js', 'GPU', 'Docker'],
    employmentType: 'full-time',
    salaryMin: 25000000,
    salaryMax: 45000000,
    salaryCurrency: 'VND',
    salaryPeriod: 'month',
    postedByName: 'AI Markets HR',
  },
  {
    slug: 'freelance-n8n-automation',
    title: 'Freelance n8n / Workflow Automation',
    company: 'Growth Studio',
    description: 'Thiết lập workflow tự động hóa marketing và onboarding khách hàng với n8n + OpenClaw.',
    location: 'Remote',
    remote: true,
    fieldIds: ['ai-automation'],
    skills: ['n8n', 'Zapier', 'API Integration'],
    employmentType: 'freelance',
    salaryNegotiable: true,
    postedByName: 'Growth Studio',
  },
  {
    slug: 'content-creator-ai',
    title: 'AI Content Creator (Part-time)',
    company: 'Creator Hub',
    description: 'Viết script, social post và landing copy với hỗ trợ LLM cho catalog AI Markets.',
    location: 'Hồ Chí Minh · Hybrid',
    remote: false,
    fieldIds: ['ai-content', 'marketing'],
    skills: ['Copywriting', 'SEO', 'ChatGPT'],
    employmentType: 'part-time',
    salaryMin: 15000000,
    salaryMax: 20000000,
    salaryCurrency: 'VND',
    salaryPeriod: 'month',
    postedByName: 'Creator Hub',
  },
  {
    slug: 'mobile-app-developer',
    title: 'Mobile App Developer',
    company: 'AppForge',
    description: 'Phát triển app React Native kết nối marketplace API và ví nội bộ.',
    location: 'Đà Nẵng',
    remote: true,
    fieldIds: ['mobile-dev', 'web-dev'],
    skills: ['React Native', 'TypeScript', 'REST API'],
    employmentType: 'contract',
    salaryMin: 500000,
    salaryMax: 800000,
    salaryCurrency: 'VND',
    salaryPeriod: 'hour',
    postedByName: 'AppForge',
  },
];

async function ensureSeed() {
  if (!isDbReady()) return;
  const talentCount = await TalentProfile.countDocuments();
  if (talentCount === 0) {
    await TalentProfile.insertMany(SEED_TALENTS);
  }
  const jobCount = await JobPosting.countDocuments({ status: 'open' });
  if (jobCount === 0) {
    await JobPosting.insertMany(SEED_JOBS.map((j) => ({ ...j, status: 'open' })));
  }
}

router.get('/fields', (_req, res) => {
  res.json(WORK_FIELDS);
});

router.get('/jobs', async (req, res, next) => {
  try {
    await ensureSeed();
    const filter = { status: 'open' };
    const field = String(req.query.field || '').trim();
    if (field) filter.fieldIds = field;
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) {
      const safe = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: safe }, { company: safe }, { description: safe }, { skills: safe }];
    }
    const docs = await JobPosting.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.json(docs.map(mapJob));
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:slug', async (req, res, next) => {
  try {
    const doc = await JobPosting.findOne({ slug: String(req.params.slug).toLowerCase() });
    if (!doc) return res.status(404).json({ message: 'Job not found' });
    res.json(mapJob(doc));
  } catch (err) {
    next(err);
  }
});

router.post('/jobs', authenticate, async (req, res, next) => {
  try {
    const body = req.body || {};
    const title = String(body.title || '').trim();
    const company = String(body.company || '').trim();
    const description = String(body.description || '').trim();
    if (!title || !company || !description) {
      return res.status(400).json({ message: 'title, company, and description are required' });
    }
    let slug = slugify(title);
    const exists = await JobPosting.findOne({ slug });
    if (exists) slug = `${slug}-${Date.now().toString(36)}`;

    const doc = await JobPosting.create({
      slug,
      title,
      company,
      description,
      location: String(body.location || 'Remote').trim(),
      remote: body.remote !== false,
      fieldIds: Array.isArray(body.fieldIds) ? body.fieldIds.map(String) : [],
      skills: Array.isArray(body.skills) ? body.skills.map(String) : [],
      employmentType: body.employmentType || 'freelance',
      salaryMin: Number(body.salaryMin) || 0,
      salaryMax: Number(body.salaryMax) || 0,
      salaryCurrency: String(body.salaryCurrency || 'VND'),
      salaryPeriod: body.salaryPeriod || 'hour',
      salaryNegotiable: !!body.salaryNegotiable,
      status: 'open',
      postedBy: req.user._id,
      postedByName: req.user.name || '',
    });
    res.status(201).json(mapJob(doc));
  } catch (err) {
    next(err);
  }
});

router.get('/talents', async (req, res, next) => {
  try {
    await ensureSeed();
    const filter = { available: true };
    const field = String(req.query.field || '').trim();
    if (field) filter.fieldIds = field;
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) {
      const safe = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: safe }, { title: safe }, { bio: safe }, { skills: safe }];
    }
    const docs = await TalentProfile.find(filter).sort({ rating: -1, createdAt: -1 }).limit(100).lean();
    res.json(docs.map(mapTalent));
  } catch (err) {
    next(err);
  }
});

router.get('/talents/:slug', async (req, res, next) => {
  try {
    const doc = await TalentProfile.findOne({ slug: String(req.params.slug).toLowerCase() });
    if (!doc) return res.status(404).json({ message: 'Talent not found' });
    res.json(mapTalent(doc));
  } catch (err) {
    next(err);
  }
});

router.post('/talents', authenticate, async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || req.user.name || '').trim();
    const title = String(body.title || '').trim();
    if (!name || !title) {
      return res.status(400).json({ message: 'name and title are required' });
    }
    let slug = slugify(`${name}-${title}`);
    const exists = await TalentProfile.findOne({ slug });
    if (exists) slug = `${slug}-${Date.now().toString(36)}`;

    const doc = await TalentProfile.create({
      slug,
      user: req.user._id,
      name,
      title,
      avatarUrl: body.avatarUrl || req.user.avatarUrl || '',
      bio: String(body.bio || '').trim(),
      fieldIds: Array.isArray(body.fieldIds) ? body.fieldIds.map(String) : [],
      skills: Array.isArray(body.skills) ? body.skills.map(String) : [],
      experienceYears: Number(body.experienceYears) || 0,
      hoursPerWeek: Number(body.hoursPerWeek) || 40,
      rateAmount: Number(body.rateAmount) || 0,
      rateCurrency: String(body.rateCurrency || 'VND'),
      rateNegotiable: body.rateNegotiable !== false,
      available: body.available !== false,
    });
    res.status(201).json(mapTalent(doc));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
