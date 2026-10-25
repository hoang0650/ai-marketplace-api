/**
 * Online-only OpenClaw skill packs.
 *
 *   GET  /v1/skills/:slug/loader.zip   thin loader package (SKILL.md + stubs, no skill logic; public)
 *   GET  /v1/skills/:slug              licensed: scripts, resources, license expiry, quota
 *   GET  /v1/skills/:slug/resources/*  licensed: prompts/, schema/, examples/ text
 *   POST /v1/skills/:slug/run          licensed: { script, argv[], files[{path, data}] } → runs server-side
 *
 * Auth: Authorization: Bearer <JWT | mk_live_ key> + X-License-Key (the caller's own key). The license is
 * checked on every call. The skill code runs in the AI service sandbox and is never sent to buyers.
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const Product = require('../models/Product');
const ContentEpisode = require('../models/ContentEpisode');
const config = require('../config/env');
const minio = require('../config/minio');
const { productSlugQuery } = require('../utils/product-slug');
const { onlineAuth, marketplaceKeyAllows } = require('../middleware/online-auth');
const online = require('../utils/online-access');
const { readZip, writeZip } = require('../utils/zip-lite');

const router = express.Router();
const BUNDLE_TTL_MS = 10 * 60 * 1000;
const bundles = new Map(); // productId -> { at, root, files: Map, zip: Buffer, sha }
const MAX_RUN_UPLOAD = 20 * 1024 * 1024;
const RESOURCE_DIRS = ['prompts/', 'schema/', 'examples/', 'templates/'];

const LOADER_PY = fs.readFileSync(path.join(__dirname, '../data/skill-loader/loader.py'), 'utf8');
const RESOURCE_PY = fs.readFileSync(path.join(__dirname, '../data/skill-loader/resource.py'), 'utf8');

async function findSkill(slug) {
  return Product.findOne({ ...productSlugQuery(slug), category: 'skill-pack' })
    .select('name slug category creator ownershipType runtime contentMeta')
    .lean();
}

/** Server-side runs are enabled for platform-operated skills; third-party code needs admin approval. */
function serverRunAllowed(product) {
  return product.ownershipType === 'PLATFORM_DIRECT' || product.contentMeta?.onlineRunApproved === true;
}

async function readObject(objectName) {
  const chunks = [];
  for await (const c of await minio.getContentObjectStream(objectName)) chunks.push(c);
  return Buffer.concat(chunks);
}

/** The skill folder from the product's stored package (.zip / .skill), cached ≤10 min. */
async function loadBundle(product) {
  const key = String(product._id);
  const hit = bundles.get(key);
  if (hit && Date.now() - hit.at < BUNDLE_TTL_MS) return hit;
  const eps = await ContentEpisode.find({ product: product._id, published: true }).sort({ index: 1 }).lean();
  const pkg = eps.find((e) => /\.zip$/i.test(e.title) && e.objectName) || eps.find((e) => /\.skill$/i.test(e.title) && e.objectName);
  if (!pkg) throw Object.assign(new Error('Skill package not uploaded'), { status: 409, code: 'SKILL_PACKAGE_MISSING' });
  const zip = await readObject(pkg.objectName);
  const raw = readZip(zip);
  const skillMd = [...raw.keys()].find((n) => /(^|\/)SKILL\.md$/.test(n));
  if (!skillMd) throw Object.assign(new Error('SKILL.md missing in package'), { status: 409, code: 'SKILL_PACKAGE_INVALID' });
  const root = skillMd.slice(0, -'SKILL.md'.length);
  const files = new Map();
  for (const [n, buf] of raw) if (n.startsWith(root)) files.set(n.slice(root.length), buf);
  const entry = { at: Date.now(), root: root.replace(/\/$/, '') || product.slug, files, zip, sha: crypto.createHash('sha256').update(zip).digest('hex') };
  bundles.set(key, entry);
  return entry;
}

function scriptsOf(bundle) {
  return [...bundle.files.keys()].filter((n) => /^scripts\/[\w.-]+\.py$/.test(n)).map((n) => n.slice('scripts/'.length));
}

function resourcesOf(bundle) {
  return [...bundle.files.keys()].filter((n) => RESOURCE_DIRS.some((d) => n.startsWith(d)));
}

async function gate(req, res) {
  const product = await findSkill(req.params.slug);
  if (!product) {
    res.status(404).json({ message: 'Skill not found', code: 'SKILL_NOT_FOUND' });
    return null;
  }
  if (!marketplaceKeyAllows(req, product)) {
    res.status(403).json({ message: 'This API key was created for another product.', code: 'API_KEY_PRODUCT_MISMATCH' });
    return null;
  }
  const access = await online.resolveOnlineAccess({ user: req.user, product, licenseKey: req.get('x-license-key'), requireKey: true });
  if (!access.via) {
    online.sendDenied(res, access.reason);
    return null;
  }
  return { product, access };
}

function sendErr(res, next, err) {
  if (err.status === 429) return online.sendQuotaError(res, err);
  if (err.status && err.status < 500) return res.status(err.status).json({ message: err.message, code: err.code });
  if (err.status) return res.status(err.status).json({ message: err.message, code: err.code || 'SKILL_RUNTIME_ERROR' });
  return next(err);
}

// ---------- loader package (public: contains no skill logic) ----------
function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  return m ? { head: m[1], body: md.slice(m[0].length) } : { head: '', body: md };
}

function yamlField(head, name) {
  const m = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(head);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

function onlineSection(slug) {
  return [
    '## Chạy online qua AI Markets (bắt buộc)',
    '',
    'Gói này là **loader mỏng**: logic skill không nằm trên máy, mỗi lệnh được chạy trên máy chủ AI Markets và',
    'kiểm tra license **mỗi lần chạy**. License hết hạn → lệnh dừng với thông báo rõ ràng (exit code 3).',
    '',
    'Cấu hình một lần (lấy ở trang sản phẩm → **Dùng online**):',
    '```bash',
    'export AIMARKETS_LICENSE_KEY=AIM-XXXX-XXXX-XXXX-XXXX   # license key của bạn',
    'export AIMARKETS_API_KEY=mk_live_...                    # API key cho sản phẩm này',
    `python3 {baseDir}/scripts/aim_resource.py --check       # kiểm tra license + kết nối`,
    '```',
    `Hoặc đặt trong \`~/.openclaw/openclaw.json\` → \`skills.entries.<tên skill>.env\`, hay \`~/.config/aimarkets/skills.json\` → \`{"${slug}": {"licenseKey": "...", "apiKey": "..."}}\`.`,
    '',
    '- Lệnh giữ nguyên như dưới đây. File đầu vào nêu trong lệnh được gửi lên để xử lý, file đầu ra được ghi về máy bạn;',
    '  dữ liệu chỉ dùng cho lần chạy đó và bị xoá ngay sau khi chạy. Hỏi ý người dùng trước khi gửi dữ liệu nhạy cảm.',
    '- File trong `prompts/`, `schema/`, `examples/` lấy bằng: `python3 {baseDir}/scripts/aim_resource.py prompts/<tên file>`.',
    '',
    '_EN: thin loader — the skill runs on AI Markets with a license check on every run; set AIMARKETS_LICENSE_KEY and AIMARKETS_API_KEY._',
    '',
  ].join('\n');
}

function loaderSkillMd(bundle, product) {
  const src = bundle.files.get('SKILL.md')?.toString('utf8') || '';
  const { head, body } = frontmatter(src);
  const name = yamlField(head, 'name') || bundle.root;
  const desc = yamlField(head, 'description') || product.name;
  const emoji = /emoji:\s*"?([^"\n]+)"?/.exec(head)?.[1]?.trim() || '🧩';
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(`${desc} Chạy online qua AI Markets (cần license key).`)}`,
    'license: MIT (loader only; the skill logic runs on AI Markets under the product license)',
    'metadata:',
    '  openclaw:',
    `    emoji: "${emoji}"`,
    '    primaryEnv: AIMARKETS_LICENSE_KEY',
    '    requires:',
    '      bins:',
    '        - python3',
    '      env:',
    '        - AIMARKETS_LICENSE_KEY',
    '        - AIMARKETS_API_KEY',
    '---',
    '',
  ].join('\n');
  let b = body
    .replace(/Bộ công cụ offline \([^)]*\)/g, 'Bộ công cụ chạy online qua AI Markets')
    .replace(/Công cụ offline,[^`]*?thư viện chuẩn(?: \([^)]*\))?\./g, 'Công cụ chạy online qua AI Markets (máy bạn chỉ cần Python 3 để chạy loader).')
    .replace(/\n## Kiểm thử\n```bash\n[^`]*```\n?/g, '\n');
  const h1 = /^# .*$/m.exec(b);
  b = h1 ? `${b.slice(0, h1.index + h1[0].length)}\n\n${onlineSection(product.slug)}${b.slice(h1.index + h1[0].length)}` : `${onlineSection(product.slug)}\n${b}`;
  return fm + b.replace(/^\n+/, '\n');
}

function buildLoaderZip(bundle, product) {
  const root = bundle.root;
  const entries = [{ name: `${root}/SKILL.md`, data: loaderSkillMd(bundle, product) }];
  for (const s of scriptsOf(bundle)) {
    entries.push({ name: `${root}/scripts/${s}`, data: LOADER_PY.replace(/__SLUG__/g, product.slug).replace(/__SCRIPT__/g, s), mode: 0o100755 });
  }
  entries.push({ name: `${root}/scripts/aim_resource.py`, data: RESOURCE_PY.replace(/__SLUG__/g, product.slug), mode: 0o100755 });
  entries.push({
    name: `${root}/LICENSE-LOADER.txt`,
    data: 'MIT License — applies to the loader stubs in this package only.\nCopyright (c) 2026 AI Markets\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.\n\nThe skill logic itself is not included; it runs on AI Markets under the terms of the product license.\n',
  });
  return writeZip(entries);
}

const loaderLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

router.get('/:slug/loader.zip', loaderLimiter, async (req, res, next) => {
  try {
    const product = await findSkill(req.params.slug);
    if (!product) return res.status(404).json({ message: 'Skill not found', code: 'SKILL_NOT_FOUND' });
    const bundle = await loadBundle(product);
    const zip = buildLoaderZip(bundle, product);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.root}-online-loader.zip"`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(zip);
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.get('/:slug', onlineAuth, async (req, res, next) => {
  try {
    const ctx = await gate(req, res);
    if (!ctx) return;
    const bundle = await loadBundle(ctx.product);
    const trace = online.traceId(String(ctx.access.license?._id || req.user._id));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Trace-Id', trace);
    res.json({
      skill: ctx.product.slug,
      name: bundle.root,
      access: ctx.access.via,
      license: ctx.access.license ? { expiresAt: ctx.access.license.expiresAt, term: ctx.access.license.licenseTerm || null } : null,
      scripts: scriptsOf(bundle),
      resources: resourcesOf(bundle),
      serverRun: serverRunAllowed(ctx.product),
      loader: `/v1/skills/${ctx.product.slug}/loader.zip`,
      quota: online.quotaDefaults().skill,
      traceId: trace,
    });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.get('/:slug/resources/*', onlineAuth, async (req, res, next) => {
  try {
    const ctx = await gate(req, res);
    if (!ctx) return;
    const rel = String(req.params[0] || '').replace(/^\/+/, '');
    if (rel.includes('..') || !RESOURCE_DIRS.some((d) => rel.startsWith(d))) {
      return res.status(404).json({ message: 'Resource not found', code: 'RESOURCE_NOT_FOUND' });
    }
    const bundle = await loadBundle(ctx.product);
    const buf = bundle.files.get(rel);
    if (!buf) return res.status(404).json({ message: 'Resource not found', code: 'RESOURCE_NOT_FOUND' });
    const trace = online.traceId(String(ctx.access.license?._id || req.user._id));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Trace-Id', trace);
    res.type(/\.json$/i.test(rel) ? 'application/json' : 'text/plain; charset=utf-8').send(buf);
  } catch (err) {
    sendErr(res, next, err);
  }
});

function cleanRunBody(body, scripts) {
  const script = String(body?.script || '').trim();
  if (!scripts.includes(script)) throw Object.assign(new Error('Unknown script'), { status: 400, code: 'SKILL_SCRIPT_UNKNOWN' });
  const argv = Array.isArray(body?.argv) ? body.argv.map((a) => String(a)) : [];
  if (argv.length > 64 || argv.some((a) => a.length > 20000)) throw Object.assign(new Error('Too many / too long arguments'), { status: 400, code: 'SKILL_ARGS_INVALID' });
  for (const a of argv) {
    const v = a.startsWith('--') && a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
    if (path.isAbsolute(v) || /^[a-zA-Z]:[\\/]/.test(v) || v.replace(/\\/g, '/').split('/').includes('..')) {
      throw Object.assign(new Error('Absolute or parent paths are not allowed; the loader maps local files for you'), { status: 400, code: 'SKILL_ARGS_INVALID' });
    }
  }
  // files: [{ path: 'in/0/policy.json', data: <base64> }] (an array: mongo-sanitize strips dotted object keys)
  const files = {};
  let total = 0;
  const list = Array.isArray(body?.files) ? body.files : [];
  if (list.length > 400) throw Object.assign(new Error('Too many files'), { status: 400, code: 'SKILL_FILES_INVALID' });
  for (const f of list) {
    const k = f?.path;
    const v = f?.data || '';
    const rel = String(k).replace(/\\/g, '/');
    if (!/^(in|out)\/[\w./ -]+$/.test(rel) || rel.split('/').includes('..')) throw Object.assign(new Error('Bad file path'), { status: 400, code: 'SKILL_FILES_INVALID' });
    total += Math.ceil((String(v).length * 3) / 4);
    if (total > MAX_RUN_UPLOAD) throw Object.assign(new Error('Input files exceed 20 MB'), { status: 413, code: 'SKILL_FILES_TOO_LARGE' });
    files[rel] = String(v);
  }
  return { script, argv, files };
}

async function callRunner(payload) {
  const base = String(config.denglishApiUrl || '').replace(/\/$/, '');
  if (!base) throw Object.assign(new Error('Skill runtime not configured'), { status: 503, code: 'SKILL_RUNTIME_UNAVAILABLE' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const r = await fetch(`${base}/skills/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.denglishServiceKey ? { 'X-Service-Key': config.denglishServiceKey } : {}) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await r.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text.slice(0, 300) };
    }
    if (!r.ok) throw Object.assign(new Error(`Skill runtime error: ${data.detail || r.status}`), { status: 502, code: 'SKILL_RUNTIME_ERROR' });
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Skill run timed out'), { status: 504, code: 'SKILL_RUN_TIMEOUT' });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

router.post('/:slug/run', onlineAuth, async (req, res, next) => {
  try {
    const ctx = await gate(req, res);
    if (!ctx) return;
    if (!serverRunAllowed(ctx.product)) {
      return res.status(409).json({ message: 'Online runs for this skill are pending admin approval.', code: 'SKILL_ONLINE_RUN_NOT_APPROVED' });
    }
    const bundle = await loadBundle(ctx.product);
    const body = cleanRunBody(req.body, scriptsOf(bundle));
    let quota = null;
    if (ctx.access.via === 'license') {
      quota = await online.takeQuota({ scope: online.usageScope(ctx.access, req.user, ctx.product), kind: 'skill', limits: online.quotaDefaults().skill });
    }
    const out = await callRunner({
      bundleSha256: bundle.sha,
      bundleB64: bundle.zip.toString('base64'),
      root: bundle.root,
      entry: `scripts/${body.script}`,
      argv: body.argv,
      files: body.files,
    });
    if (quota) await quota.commit(1);
    const trace = online.traceId(String(ctx.access.license?._id || req.user._id));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Trace-Id', trace);
    res.json({
      exitCode: Number(out.exitCode ?? out.exit_code ?? 0),
      stdout: String(out.stdout || ''),
      stderr: String(out.stderr || ''),
      // [{ path, data(base64) }] — written next to the caller by the loader
      files: Object.entries(out.files || {}).map(([p, d]) => ({ path: p, data: d })),
      timedOut: !!out.timedOut,
      access: ctx.access.via,
      licenseExpiresAt: ctx.access.license?.expiresAt || null,
      traceId: trace,
    });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router._test = { loaderSkillMd, buildLoaderZip, cleanRunBody, serverRunAllowed, scriptsOf, frontmatter };
module.exports = router;
