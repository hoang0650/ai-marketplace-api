const express = require('express');
const JobPosting = require('../models/JobPosting');
const TalentProfile = require('../models/TalentProfile');
const JobApplication = require('../models/JobApplication');
const { authenticate, requireRoles } = require('../middleware/auth');
const { ROLE } = require('../utils/roles');
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
    postedBy: j.postedBy?.toString?.() || j.postedBy || '',
    postedByName: j.postedByName || '',
    applicationsCount: j.applicationsCount || 0,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

function mapApplication(doc, { meId, employerId, job } = {}) {
  const a = doc.toJSON ? doc.toJSON() : doc;
  const applicantId = String(a.applicant?._id || a.applicant || '');
  const isMine = meId && applicantId === String(meId);
  const isEmployer = meId && employerId && String(meId) === String(employerId);
  return {
    id: String(a.id || a._id),
    jobId: String(a.job?._id || a.job || ''),
    jobSlug: job?.slug || a.jobSlug || '',
    jobTitle: job?.title || a.jobTitle || '',
    applicantId,
    applicantName: a.applicantName || a.applicant?.name || 'Ứng viên',
    applicantAvatar: a.applicantAvatar || a.applicant?.avatarUrl || '',
    proposedAmount: Number(a.proposedAmount) || 0,
    proposedCurrency: a.proposedCurrency || 'VND',
    proposedPeriod: a.proposedPeriod || 'project',
    coverLetter: isMine || isEmployer ? a.coverLetter || '' : '',
    status: a.status || 'pending',
    workStatus: a.workStatus || 'none',
    deliveryNote: isMine || isEmployer ? a.deliveryNote || '' : '',
    deliveryUrls: isMine || isEmployer ? a.deliveryUrls || [] : [],
    deliveredAt: a.deliveredAt || null,
    revisionNote: isMine || isEmployer ? a.revisionNote || '' : '',
    revisionCount: Number(a.revisionCount) || 0,
    completedAt: a.completedAt || null,
    disputedAt: a.disputedAt || null,
    conversationId: isMine || isEmployer ? String(a.conversation || '') || undefined : undefined,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    mine: !!isMine,
  };
}

function parseDeliveryUrls(raw) {
  const list = Array.isArray(raw)
    ? raw
    : String(raw || '')
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
  const urls = [];
  for (const item of list.slice(0, 8)) {
    try {
      const u = new URL(item);
      if (u.protocol === 'http:' || u.protocol === 'https:') urls.push(u.toString().slice(0, 500));
    } catch {
      /* skip */
    }
  }
  return urls;
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

/** Public competing bids on a job (freelance-style price board). */
router.get('/jobs/:slug/applications', authenticate, async (req, res, next) => {
  try {
    const job = await JobPosting.findOne({ slug: String(req.params.slug).toLowerCase() });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const employerId = job.postedBy?.toString?.() || job.postedBy || '';
    const rows = await JobApplication.find({ job: job._id, status: { $ne: 'withdrawn' } })
      .populate('applicant', 'name avatarUrl')
      .sort({ proposedAmount: 1, createdAt: 1 })
      .limit(100)
      .lean({ virtuals: true });
    res.json(rows.map((r) => mapApplication(r, { meId: req.user._id, employerId })));
  } catch (err) {
    next(err);
  }
});

/** Guest-readable bid board (amounts only — for competition). Auth optional enrich. */
router.get('/jobs/:slug/bids', async (req, res, next) => {
  try {
    const job = await JobPosting.findOne({ slug: String(req.params.slug).toLowerCase() });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const rows = await JobApplication.find({ job: job._id, status: { $in: ['pending', 'accepted'] } })
      .sort({ proposedAmount: 1, createdAt: 1 })
      .limit(100)
      .lean({ virtuals: true });
    res.json(
      rows.map((r) => ({
        id: String(r._id),
        applicantName: r.applicantName || 'Ứng viên',
        applicantAvatar: r.applicantAvatar || '',
        proposedAmount: Number(r.proposedAmount) || 0,
        proposedCurrency: r.proposedCurrency || 'VND',
        proposedPeriod: r.proposedPeriod || 'project',
        status: r.status,
        createdAt: r.createdAt,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:slug/applications', authenticate, requireRoles(ROLE.FREELANCER, ROLE.ADMIN), async (req, res, next) => {
  try {
    const job = await JobPosting.findOne({ slug: String(req.params.slug).toLowerCase() });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (job.status !== 'open') return res.status(400).json({ message: 'Job is closed' });
    const employerId = job.postedBy?.toString?.() || job.postedBy;
    if (!employerId) {
      return res.status(400).json({ message: 'Job has no employer account to negotiate with' });
    }
    if (String(employerId) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot apply to your own job' });
    }

    const body = req.body || {};
    const proposedAmount = Number(body.proposedAmount);
    if (!Number.isFinite(proposedAmount) || proposedAmount <= 0) {
      return res.status(400).json({ message: 'proposedAmount is required' });
    }
    const proposedCurrency = String(body.proposedCurrency || job.salaryCurrency || 'VND').trim().slice(0, 8);
    const proposedPeriod = ['hour', 'day', 'week', 'month', 'project'].includes(body.proposedPeriod)
      ? body.proposedPeriod
      : job.salaryPeriod || 'project';
    const coverLetter = String(body.coverLetter || '').trim().slice(0, 2000);

    let app;
    try {
      app = await JobApplication.create({
        job: job._id,
        applicant: req.user._id,
        applicantName: req.user.name || '',
        applicantAvatar: req.user.avatarUrl || '',
        proposedAmount,
        proposedCurrency,
        proposedPeriod,
        coverLetter,
        status: 'pending',
      });
      await JobPosting.updateOne({ _id: job._id }, { $inc: { applicationsCount: 1 } });
    } catch (err) {
      if (err.code !== 11000) throw err;
      app = await JobApplication.findOneAndUpdate(
        { job: job._id, applicant: req.user._id },
        {
          $set: {
            proposedAmount,
            proposedCurrency,
            proposedPeriod,
            coverLetter,
            applicantName: req.user.name || '',
            applicantAvatar: req.user.avatarUrl || '',
            status: 'pending',
          },
        },
        { new: true },
      );
    }

    res.status(201).json(mapApplication(app, { meId: req.user._id, employerId }));
  } catch (err) {
    next(err);
  }
});

router.get('/applications/mine', authenticate, async (req, res, next) => {
  try {
    const rows = await JobApplication.find({ applicant: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean({ virtuals: true });
    res.json(rows.map((r) => mapApplication(r, { meId: req.user._id })));
  } catch (err) {
    next(err);
  }
});

router.patch('/applications/:id', authenticate, async (req, res, next) => {
  try {
    const app = await JobApplication.findById(req.params.id);
    if (!app) return res.status(404).json({ message: 'Application not found' });
    const job = await JobPosting.findById(app.job);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const employerId = String(job.postedBy || '');
    const isEmployer = employerId === String(req.user._id);
    const isApplicant = String(app.applicant) === String(req.user._id);
    const status = String(req.body?.status || '').trim();
    if (isApplicant && status === 'withdrawn') {
      if (['delivered', 'completed', 'disputed'].includes(app.workStatus)) {
        return res.status(400).json({ message: 'Cannot withdraw after delivery/completion' });
      }
      app.status = 'withdrawn';
      app.workStatus = 'cancelled';
      await app.save();
      return res.json(mapApplication(app, { meId: req.user._id, employerId, job }));
    }
    if (isEmployer && (status === 'accepted' || status === 'rejected')) {
      app.status = status;
      if (status === 'accepted') {
        app.workStatus = 'hired';
        // Close other pending apps on this job (optional soft reject)
        await JobApplication.updateMany(
          { job: job._id, _id: { $ne: app._id }, status: 'pending' },
          { $set: { status: 'rejected' } },
        );
      }
      await app.save();
      return res.json(mapApplication(app, { meId: req.user._id, employerId, job }));
    }
    return res.status(403).json({ message: 'Forbidden' });
  } catch (err) {
    next(err);
  }
});

/** Freelancer submits delivery. */
router.post('/applications/:id/deliver', authenticate, async (req, res, next) => {
  try {
    const app = await JobApplication.findById(req.params.id);
    if (!app) return res.status(404).json({ message: 'Application not found' });
    if (String(app.applicant) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only the hired freelancer can deliver' });
    }
    if (app.status !== 'accepted') {
      return res.status(400).json({ message: 'Application must be accepted first' });
    }
    if (!['hired', 'in_progress', 'revision_requested'].includes(app.workStatus)) {
      return res.status(400).json({ message: `Cannot deliver from status ${app.workStatus}` });
    }
    const note = String(req.body?.note || req.body?.deliveryNote || '').trim().slice(0, 4000);
    if (note.length < 4) {
      return res.status(400).json({ message: 'delivery note required (min 4 chars)' });
    }
    app.deliveryNote = note;
    app.deliveryUrls = parseDeliveryUrls(req.body?.urls || req.body?.deliveryUrls);
    app.deliveredAt = new Date();
    app.workStatus = 'delivered';
    await app.save();
    const job = await JobPosting.findById(app.job);
    const employerId = String(job?.postedBy || '');
    res.json(mapApplication(app, { meId: req.user._id, employerId, job }));
  } catch (err) {
    next(err);
  }
});

/** Employer accepts delivery → job completed. */
router.post('/applications/:id/complete', authenticate, async (req, res, next) => {
  try {
    const app = await JobApplication.findById(req.params.id);
    if (!app) return res.status(404).json({ message: 'Application not found' });
    const job = await JobPosting.findById(app.job);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (String(job.postedBy || '') !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only the employer can complete the job' });
    }
    if (app.workStatus !== 'delivered') {
      return res.status(400).json({ message: 'Freelancer must deliver before completion' });
    }
    app.workStatus = 'completed';
    app.completedAt = new Date();
    await app.save();
    res.json(mapApplication(app, { meId: req.user._id, employerId: String(job.postedBy), job }));
  } catch (err) {
    next(err);
  }
});

/** Employer requests revision (max 3). */
router.post('/applications/:id/revision', authenticate, async (req, res, next) => {
  try {
    const app = await JobApplication.findById(req.params.id);
    if (!app) return res.status(404).json({ message: 'Application not found' });
    const job = await JobPosting.findById(app.job);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (String(job.postedBy || '') !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only the employer can request revision' });
    }
    if (app.workStatus !== 'delivered') {
      return res.status(400).json({ message: 'Revision only after delivery' });
    }
    if ((app.revisionCount || 0) >= 3) {
      return res.status(400).json({ message: 'Maximum 3 revision rounds. Open a complaint if still unresolved.' });
    }
    const note = String(req.body?.note || '').trim().slice(0, 2000);
    if (note.length < 4) {
      return res.status(400).json({ message: 'revision note required' });
    }
    app.revisionNote = note;
    app.revisionCount = (app.revisionCount || 0) + 1;
    app.workStatus = 'revision_requested';
    await app.save();
    res.json(mapApplication(app, { meId: req.user._id, employerId: String(job.postedBy), job }));
  } catch (err) {
    next(err);
  }
});

/** Freelancer marks in progress after hire. */
router.post('/applications/:id/start', authenticate, async (req, res, next) => {
  try {
    const app = await JobApplication.findById(req.params.id);
    if (!app) return res.status(404).json({ message: 'Application not found' });
    if (String(app.applicant) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only the freelancer can start work' });
    }
    if (app.status !== 'accepted' || !['hired', 'revision_requested'].includes(app.workStatus)) {
      return res.status(400).json({ message: 'Cannot start from current status' });
    }
    if (app.workStatus === 'hired') app.workStatus = 'in_progress';
    await app.save();
    const job = await JobPosting.findById(app.job);
    res.json(mapApplication(app, { meId: req.user._id, employerId: String(job?.postedBy || ''), job }));
  } catch (err) {
    next(err);
  }
});

/** Contracts list for manage dashboard. */
router.get('/contracts/mine', authenticate, async (req, res, next) => {
  try {
    const as = String(req.query.as || 'all');
    const myJobs = await JobPosting.find({ postedBy: req.user._id }).select('_id slug title postedBy').lean();
    const jobIds = myJobs.map((j) => j._id);
    const jobMap = Object.fromEntries(myJobs.map((j) => [String(j._id), j]));
    const filter =
      as === 'employer'
        ? { job: { $in: jobIds }, status: 'accepted' }
        : as === 'freelancer'
          ? { applicant: req.user._id, status: 'accepted' }
          : {
              status: 'accepted',
              $or: [{ applicant: req.user._id }, { job: { $in: jobIds } }],
            };
    const rows = await JobApplication.find(filter).sort({ updatedAt: -1 }).limit(100).lean({ virtuals: true });
    const missingJobIds = [...new Set(rows.map((r) => String(r.job)).filter((id) => !jobMap[id]))];
    if (missingJobIds.length) {
      const extra = await JobPosting.find({ _id: { $in: missingJobIds } }).select('_id slug title postedBy').lean();
      for (const j of extra) jobMap[String(j._id)] = j;
    }
    res.json(
      rows.map((r) => {
        const job = jobMap[String(r.job)];
        return mapApplication(r, {
          meId: req.user._id,
          employerId: String(job?.postedBy || ''),
          job,
        });
      }),
    );
  } catch (err) {
    next(err);
  }
});

router.post('/jobs', authenticate, requireRoles(ROLE.EMPLOYER, ROLE.ADMIN), async (req, res, next) => {
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

router.post('/talents', authenticate, requireRoles(ROLE.TALENT, ROLE.ADMIN), async (req, res, next) => {
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
