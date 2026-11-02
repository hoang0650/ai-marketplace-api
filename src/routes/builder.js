const crypto = require('crypto');
const config = require('../config/env');
const express = require('express');
const mongoose = require('mongoose');
const BuilderProject = require('../models/BuilderProject');
const Product = require('../models/Product');
const ProviderApiKey = require('../models/ProviderApiKey');
const { authenticate } = require('../middleware/auth');
const { openSecret } = require('../utils/secret-box');
const { getByokProvider, publicProviderList } = require('../utils/byok-providers');
const { apiBase } = require('../utils/training/bundle');
const files = require('../utils/builder/files');
const { buildMessages } = require('../utils/builder/prompts');

const LOCAL_PROVIDER = 'local';
const LOCAL_TEXT_MAX = 2_000_000;
const llm = require('../utils/builder/llm');
const { previewResponse } = require('../utils/builder/preview');
const QRCode = require('qrcode');
const expoSnack = require('../utils/builder/expo-snack');
const bus = require('../realtime/user-bus');

/**
 * AI App Builder (rork-style): buyers describe a website or mobile app, their own provider key
 * (BYOK, stored via /v1/openclaw/byok/keys) writes the code, and the result runs live in a
 * sandboxed preview. AI Markets does not bill tokens for BYOK usage.
 */
const router = express.Router();

const KINDS = ['web', 'app'];
const PROMPT_MAX = 8000;
const MESSAGES_KEEP = 60;
const GENERATION_TIMEOUT_MS = 8 * 60 * 1000;
const running = new Set();

const MESSAGES = {
  PROJECT_NOT_FOUND: 'Không tìm thấy project.',
  PROJECT_LIMIT: 'Bạn đã đạt số project tối đa. Hãy xóa bớt project cũ.',
  PROJECT_KIND_INVALID: 'Loại project không hợp lệ (web hoặc app).',
  NAME_REQUIRED: 'Vui lòng đặt tên project.',
  PROMPT_REQUIRED: 'Hãy mô tả bạn muốn build gì.',
  PROMPT_TOO_LONG: `Mô tả tối đa ${PROMPT_MAX} ký tự.`,
  PROVIDER_INVALID: 'Provider không được hỗ trợ.',
  PROVIDER_UNSUPPORTED: 'Provider này chưa có endpoint tương thích OpenAI để build.',
  NO_PROVIDER_KEY: 'Bạn chưa cấu hình API key cho provider này (hoặc key đang lỗi). Thêm key ở mục API key.',
  PROVIDER_KEY_REJECTED: 'Provider từ chối API key (sai key, hết hạn hoặc chưa được cấp quyền model này).',
  PROVIDER_RATE_LIMITED: 'Provider báo vượt giới hạn hoặc hết credit. Thử lại sau hoặc nạp thêm credit tại provider.',
  PROVIDER_ERROR: 'Provider trả lỗi khi build.',
  PROVIDER_TIMEOUT: 'Provider phản hồi quá lâu, đã dừng.',
  MODEL_INVALID: 'Tên model không hợp lệ.',
  GENERATION_BUSY: 'Bạn đang có một lượt build khác chạy. Đợi xong rồi thử lại.',
  OUTPUT_TOO_LARGE: 'Phản hồi của model quá lớn.',
  EMPTY_OUTPUT: 'Model không trả về file nào. Thử mô tả cụ thể hơn hoặc đổi model mạnh hơn.',
  FILE_PATH_INVALID: 'Đường dẫn file không hợp lệ cho loại project này.',
  FILE_TOO_LARGE: 'File quá lớn.',
  FILE_NOT_FOUND: 'Không tìm thấy file.',
  PROJECT_TOO_MANY_FILES: 'Project có quá nhiều file.',
  PROJECT_TOO_LARGE: 'Project vượt dung lượng cho phép.',
  TEMPLATE_NOT_FOUND: 'Không tìm thấy template.',
  TEMPLATE_FORBIDDEN: 'Chỉ seller sở hữu template mới được cập nhật file.',
  TEMPLATE_EMPTY: 'Template chưa có file hợp lệ (web: html/css/js…, app: tsx/ts/jsx/js/json).',
  TEMPLATE_ENTRY_MISSING: 'Template thiếu file chính (web cần index.html, app cần App.tsx).',
  TEMPLATE_PURCHASE_REQUIRED: 'Bạn cần mua template này trước khi dùng để build.',
  TEMPLATE_KIND_MISMATCH: 'Project không cùng loại với template (web / app).',
  TEMPLATE_RESALE_FORBIDDEN: 'Project này tạo từ template của người bán khác nên không thể đăng bán lại làm template.',
  ZIP_INVALID: 'File ZIP bị lỗi hoặc không đúng định dạng.',
  ZIP_UNSUPPORTED: 'ZIP dùng định dạng chưa hỗ trợ (ZIP64 / nén lạ). Hãy nén lại bằng ZIP thường.',
  ZIP_ENCRYPTED: 'Không hỗ trợ ZIP có mật khẩu.',
  ZIP_TOO_MANY_FILES: 'ZIP có quá nhiều file.',
  ZIP_TOO_LARGE: 'File upload quá lớn.',
  UPLOAD_INVALID: 'Upload không hợp lệ.',
  GIT_NOT_CONFIGURED: 'Đăng nhập GitHub (OAuth) chưa được cấu hình trên server. Hãy dùng Personal Access Token.',
  GIT_NOT_CONNECTED: 'Bạn chưa kết nối tài khoản GitHub.',
  GIT_TOKEN_FORMAT: 'Token GitHub không hợp lệ.',
  GIT_TOKEN_INVALID: 'GitHub từ chối token (sai, hết hạn hoặc đã bị thu hồi). Hãy kết nối lại.',
  GIT_FORBIDDEN: 'Token GitHub không đủ quyền. Cần quyền repo (classic) hoặc Contents + Administration: Read & write (fine-grained).',
  GIT_REPO_NO_PUSH: 'Tài khoản GitHub này không có quyền push vào repo đã chọn.',
  GIT_NOT_FOUND: 'Không tìm thấy repo trên GitHub (hoặc token không được cấp quyền truy cập repo này).',
  GIT_REPO_EXISTS: 'Tên repo đã tồn tại trên tài khoản GitHub của bạn. Chọn tên khác hoặc dùng repo có sẵn.',
  GIT_REPO_INVALID: 'Tên repo không hợp lệ (chỉ chữ, số, dấu gạch ngang, gạch dưới, chấm).',
  GIT_REPO_REQUIRED: 'Chọn repo có sẵn hoặc tạo repo mới để push.',
  GIT_BRANCH_INVALID: 'Tên branch không hợp lệ.',
  GIT_MESSAGE_INVALID: 'Commit message tối đa 200 ký tự.',
  GIT_RATE_LIMITED: 'GitHub đang giới hạn tần suất gọi API. Thử lại sau ít phút.',
  GIT_CONFLICT: 'Branch trên GitHub vừa thay đổi trong lúc push. Hãy thử lại.',
  GIT_UNPROCESSABLE: 'GitHub từ chối yêu cầu',
  GIT_ERROR: 'GitHub trả lỗi',
  GIT_BUSY: 'Project đang được push lên Git. Đợi xong rồi thử lại.',
  GIT_NOTHING_TO_PUSH: 'Hãy build project (có preview) trước khi đẩy lên Git.',
  GIT_OAUTH_STATE: 'Phiên kết nối GitHub không hợp lệ hoặc đã hết hạn. Hãy thử lại.',
  GIT_OAUTH_DENIED: 'Bạn đã huỷ cấp quyền GitHub.',
  GIT_CONNECT_EXPIRED: 'Phiên kết nối GitHub đã hết hạn hoặc không thuộc tài khoản này. Hãy kết nối lại.',
  GIT_RETURN_INVALID: 'Địa chỉ quay lại không được phép.',
  GIT_PATH_INVALID: 'Thư mục trong repo không hợp lệ.',
  GIT_PATH_NOT_FOUND: 'Không tìm thấy thư mục này trong repo (hoặc thư mục không có file).',
  GIT_IMPORT_TOO_LARGE: 'Repo quá lớn để đọc một lần. Hãy chọn thư mục con chứa template.',
  TEMPLATE_BUSY: 'Template đang được cập nhật file. Đợi xong rồi thử lại.',
  TEMPLATE_BUILD_FAILED: 'Build template thất bại — xem log bên dưới, sửa trong repo rồi build lại.',
  TEMPLATE_BUILD_NOT_FOUND: 'Không tìm thấy bản build (bản build chỉ giữ 7 ngày). Hãy bấm Build lại.',
};

function httpError(status, code, extra) {
  return files.httpError(status, code, extra);
}

function errorBody(err) {
  const code = err.code || 'PROVIDER_ERROR';
  const known = MESSAGES[code];
  const withDetail = code === 'PROVIDER_ERROR' || code === 'GIT_ERROR' || code === 'GIT_UNPROCESSABLE';
  const detail = withDetail && err.message && err.message !== code ? `: ${err.message}` : '';
  return { code, message: `${known || err.message || code}${detail}`, ...(err.extra || {}) };
}

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (!err || !err.status || !err.code) return next(err);
      return res.status(err.status).json(errorBody(err));
    }
  };
}

function maxProjects() {
  const n = Number(process.env.BUILDER_MAX_PROJECTS);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

function newPreviewToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function previewUrl(doc) {
  return `${apiBase()}/v1/builder/preview/${doc._id}/${doc.previewToken}/`;
}

function publicProject(doc, full = false) {
  const base = {
    id: String(doc._id),
    name: doc.name,
    kind: doc.kind,
    provider: doc.provider || '',
    model: doc.model || '',
    version: doc.version || 0,
    fileCount: (doc.files || []).length,
    previewUrl: previewUrl(doc),
    lastGeneratedAt: doc.lastGeneratedAt,
    template: doc.template?.product
      ? {
          productId: String(doc.template.product),
          name: doc.template.name || '',
          version: doc.template.version || 0,
          own: !!doc.template.creator && String(doc.template.creator) === String(doc.owner),
        }
      : null,
    git: doc.git?.repo
      ? {
          provider: doc.git.provider,
          owner: doc.git.owner,
          repo: doc.git.repo,
          fullName: `${doc.git.owner}/${doc.git.repo}`,
          branch: doc.git.branch,
          repoUrl: doc.git.repoUrl,
          private: !!doc.git.private,
          lastCommitSha: doc.git.lastCommitSha || '',
          lastCommitUrl: doc.git.lastCommitUrl || '',
          lastPushedAt: doc.git.lastPushedAt || null,
          lastPushedVersion: doc.git.lastPushedVersion || 0,
        }
      : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  if (!full) return base;
  return {
    ...base,
    files: (doc.files || []).map((f) => ({ path: f.path, content: f.content })),
    messages: (doc.messages || []).map((m) => ({
      id: String(m._id),
      role: m.role,
      content: m.content,
      durationMs: m.durationMs || 0,
      files: m.files || [],
      provider: m.provider || '',
      model: m.model || '',
      createdAt: m.createdAt,
    })),
  };
}

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name) throw httpError(400, 'NAME_REQUIRED');
  return name;
}

function cleanModel(value) {
  const model = String(value || '').trim();
  if (model && !llm.MODEL_RE.test(model)) throw httpError(400, 'MODEL_INVALID');
  return model;
}

async function findOwned(req) {
  const id = String(req.params.id || '');
  if (!mongoose.isValidObjectId(id)) throw httpError(404, 'PROJECT_NOT_FOUND');
  const doc = await BuilderProject.findOne({ _id: id, owner: req.user._id });
  if (!doc) throw httpError(404, 'PROJECT_NOT_FOUND');
  return doc;
}

/** Projects started from a template before `template.creator` was stored: look it up once. */
async function fillTemplateCreators(docs) {
  const missing = docs.filter((d) => d.template?.product && !d.template.creator);
  if (!missing.length) return docs;
  const ids = [...new Set(missing.map((d) => String(d.template.product)))];
  const products = await Product.find({ _id: { $in: ids } }).select('creator').lean();
  const creators = new Map(products.map((p) => [String(p._id), p.creator]));
  await Promise.all(
    missing.map((d) => {
      const creator = creators.get(String(d.template.product));
      if (!creator) return null;
      d.template.creator = creator;
      return BuilderProject.updateOne({ _id: d._id }, { $set: { 'template.creator': creator } });
    })
  );
  return docs;
}

// ---------- public preview (capability link, sandboxed) ----------

/**
 * GET /v1/builder/preview-expo/:id/:token[.svg] — Expo Go link (JSON) or its QR (SVG) for an
 * app project; same capability token as the web preview.
 */
router.get(/^\/preview-expo\/([a-f0-9]{24})\/([A-Za-z0-9_-]{16,64})(\.svg)?$/, async (req, res, next) => {
  try {
    const [id, token, svg] = [req.params[0], req.params[1], req.params[2]];
    const doc = await BuilderProject.findById(id).select('name kind files previewToken').lean();
    const a = Buffer.from(String(doc?.previewToken || ''));
    const b = Buffer.from(token);
    if (!doc || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(404).type('text/plain').send('Preview not found');
    }
    const out = doc.kind === 'app'
      ? await expoSnack.ensureSnack(`prj:${id}`, { name: doc.name, files: doc.files })
      : { enabled: false, available: false, url: '', error: 'SNACK_NOT_APP' };
    if (out.url) out.landingUrl = `${String(config.frontendUrl).replace(/\/+$/, '')}/expo/p/${id}/${token}`;
    if (!svg) return res.set('Cache-Control', 'no-store').json(out);
    if (!out.url) return res.status(404).type('text/plain').send('Expo link unavailable');
    const body = await QRCode.toString(out.landingUrl || out.url, { type: 'svg', margin: 1, width: 220 });
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, max-age=60' }).send(body);
  } catch (err) {
    next(err);
  }
});

router.get(/^\/preview\/([a-f0-9]{24})\/([A-Za-z0-9_-]{16,64})(?:\/(.*))?$/, async (req, res, next) => {
  try {
    const [id, token, rest] = [req.params[0], req.params[1], req.params[2]];
    if (rest === undefined) {
      return res.redirect(302, `${req.baseUrl}/preview/${id}/${token}/`);
    }
    const doc = await BuilderProject.findById(id).select('name kind files previewToken').lean();
    const a = Buffer.from(String(doc?.previewToken || ''));
    const b = Buffer.from(token);
    if (!doc || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(404).type('text/plain').send('Preview not found');
    }
    const out = previewResponse(doc, rest);
    res.status(out.status).set(out.headers).send(out.body);
  } catch (err) {
    next(err);
  }
});

router.use(authenticate);

// ---------- providers (buyer's own keys) ----------

/** GET /v1/builder/providers — supported providers + which ones this buyer has configured. */
router.get(
  '/providers',
  wrap(async (req, res) => {
    const keys = await ProviderApiKey.find({ user: req.user._id }).sort({ provider: 1 });
    res.json({
      providers: publicProviderList().map((p) => ({ ...p, defaultModel: llm.DEFAULT_MODELS[p.id] || '' })),
      keys: keys.map((k) => k.toPublic()),
    });
  })
);

/** GET /v1/builder/providers/:provider/models — model ids the saved key can use (best effort). */
router.get(
  '/providers/:provider/models',
  wrap(async (req, res) => {
    const spec = getByokProvider(req.params.provider);
    if (!spec) throw httpError(404, 'PROVIDER_INVALID');
    const key = await ProviderApiKey.findOne({ user: req.user._id, provider: spec.id }).select('+secret');
    if (!key) throw httpError(400, 'NO_PROVIDER_KEY');
    const models = await llm.listModels({ provider: spec.id, apiKey: openSecret(key.secret), baseUrl: key.baseUrl });
    res.json({ models, defaultModel: llm.DEFAULT_MODELS[spec.id] || key.model || '' });
  })
);

// ---------- projects ----------

router.get(
  '/projects',
  wrap(async (req, res) => {
    const filter = { owner: req.user._id };
    if (KINDS.includes(req.query.kind)) filter.kind = req.query.kind;
    const rows = await fillTemplateCreators(await BuilderProject.find(filter).select('-messages').sort({ updatedAt: -1 }).limit(200));
    res.json({ projects: rows.map((d) => publicProject(d)), limits: { ...files.limits(), maxProjects: maxProjects() } });
  })
);

router.post(
  '/projects',
  wrap(async (req, res) => {
    const body = req.body || {};
    const kind = String(body.kind || '');
    if (!KINDS.includes(kind)) throw httpError(400, 'PROJECT_KIND_INVALID');
    const name = cleanName(body.name);
    const count = await BuilderProject.countDocuments({ owner: req.user._id });
    if (count >= maxProjects()) throw httpError(409, 'PROJECT_LIMIT');
    const provider = body.provider ? getByokProvider(body.provider)?.id || '' : '';
    const doc = await BuilderProject.create({
      owner: req.user._id,
      name,
      kind,
      provider,
      model: cleanModel(body.model),
      files: files.starterFiles(kind),
      previewToken: newPreviewToken(),
    });
    res.status(201).json({ project: publicProject(doc, true) });
  })
);

router.get(
  '/projects/:id',
  wrap(async (req, res) => {
    const [doc] = await fillTemplateCreators([await findOwned(req)]);
    res.json({ project: publicProject(doc, true) });
  })
);

/** PATCH /v1/builder/projects/:id — body { name?, provider?, model? } */
router.patch(
  '/projects/:id',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    const body = req.body || {};
    if (body.name !== undefined) doc.name = cleanName(body.name);
    if (body.provider !== undefined) {
      // 'local' = an OpenAI-compatible endpoint on the user's own machine, called from the browser.
      const isLocal = String(body.provider).trim().toLowerCase() === LOCAL_PROVIDER;
      const spec = body.provider && !isLocal ? getByokProvider(body.provider) : null;
      if (body.provider && !isLocal && !spec) throw httpError(400, 'PROVIDER_INVALID');
      doc.provider = isLocal ? LOCAL_PROVIDER : spec?.id || '';
    }
    if (body.model !== undefined) doc.model = cleanModel(body.model);
    await doc.save();
    res.json({ project: publicProject(doc) });
  })
);

router.delete(
  '/projects/:id',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    await doc.deleteOne();
    res.json({ success: true });
  })
);

/** POST /v1/builder/projects/:id/preview-token — revokes previously shared preview links. */
router.post(
  '/projects/:id/preview-token',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    doc.previewToken = newPreviewToken();
    await doc.save();
    res.json({ previewUrl: previewUrl(doc) });
  })
);

/** PUT /v1/builder/projects/:id/files — body { path, content } (manual edit from the code tab). */
router.put(
  '/projects/:id/files',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    const path = files.cleanPath(doc.kind, req.body?.path);
    if (!path) throw httpError(400, 'FILE_PATH_INVALID');
    const content = String(req.body?.content ?? '');
    if (files.byteLength(content) > files.limits().fileMaxBytes) throw httpError(400, 'FILE_TOO_LARGE');
    const out = files.applyChanges(doc.kind, doc.files, { files: [{ path, content }] });
    doc.files = out.files;
    doc.version += 1;
    await doc.save();
    res.json({ project: publicProject(doc, true) });
  })
);

/** DELETE /v1/builder/projects/:id/files?path=… */
router.delete(
  '/projects/:id/files',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    const path = files.cleanPath(doc.kind, req.query.path);
    if (!path || !doc.files.some((f) => f.path === path)) throw httpError(404, 'FILE_NOT_FOUND');
    doc.files = doc.files.filter((f) => f.path !== path);
    doc.version += 1;
    await doc.save();
    res.json({ project: publicProject(doc, true) });
  })
);

// ---------- generation ----------

async function resolveKey(userId, providerId) {
  const spec = getByokProvider(providerId);
  if (!spec) throw httpError(400, 'PROVIDER_INVALID');
  const key = await ProviderApiKey.findOne({ user: userId, provider: spec.id, status: 'active' }).select('+secret');
  if (!key) throw httpError(400, 'NO_PROVIDER_KEY');
  let apiKey;
  try {
    apiKey = openSecret(key.secret);
  } catch {
    throw httpError(400, 'NO_PROVIDER_KEY');
  }
  return { spec, key, apiKey };
}

/**
 * Applies one model reply to the project and records the chat turn.
 * Exported for tests; the route below handles transport (SSE or JSON).
 */
function applyGeneration(doc, { prompt, previewError, text, provider, model, durationMs = 0 }) {
  const parsed = files.parseOutput(text);
  if (!parsed.files.length && !parsed.deletes.length) {
    if (!parsed.summary) throw httpError(502, 'EMPTY_OUTPUT');
  }
  const out = files.applyChanges(doc.kind, doc.files, parsed);
  const userText = String(prompt || '').trim() || (previewError ? `Sửa lỗi: ${String(previewError).split('\n')[0]}` : '');
  doc.messages.push({ role: 'user', content: userText.slice(0, 20000) });
  doc.messages.push({
    role: 'assistant',
    content: (parsed.summary || (out.touched.length ? 'Đã cập nhật project.' : '')).slice(0, 20000),
    files: out.touched,
    provider,
    model,
    durationMs: Number.isFinite(Number(durationMs)) ? Math.min(3600000, Math.max(0, Math.round(Number(durationMs)))) : 0,
  });
  if (doc.messages.length > MESSAGES_KEEP) doc.messages.splice(0, doc.messages.length - MESSAGES_KEEP);
  doc.files = out.files;
  if (out.touched.length) doc.version += 1;
  doc.provider = provider;
  doc.model = model;
  doc.lastGeneratedAt = new Date();
  return { touched: out.touched, rejected: out.rejected, truncated: parsed.truncated };
}

/**
 * POST /v1/builder/projects/:id/generate — body { prompt, previewError?, provider?, model?, stream? }
 * Streams Server-Sent Events by default: start → delta* → done | error.
 * `stream: false` returns one JSON response (mobile clients).
 */
router.post('/projects/:id/generate', async (req, res, next) => {
  const userId = String(req.user._id);
  const body = req.body || {};
  const wantsStream = body.stream !== false;
  let streaming = false;
  let heartbeat = null;
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };
  const fail = (err) => {
    if (!err || !err.code) {
      console.error('[builder] generate failed', err);
      err = httpError(500, 'PROVIDER_ERROR');
    }
    if (streaming) {
      send('error', errorBody(err));
      return res.end();
    }
    return res.status(err.status && err.status >= 400 ? err.status : 502).json(errorBody(err));
  };

  let genStarted = '';
  if (running.has(userId)) return fail(httpError(409, 'GENERATION_BUSY'));
  running.add(userId);
  const controller = new AbortController();
  const generationStartedAt = Date.now();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), GENERATION_TIMEOUT_MS);
  res.on('close', () => {
    if (!res.writableEnded) controller.abort(new Error('client closed'));
  });

  try {
    const doc = await findOwned(req);
    const prompt = String(body.prompt || '').trim();
    const previewError = String(body.previewError || '').trim().slice(0, 2000);
    if (!prompt && !previewError) throw httpError(400, 'PROMPT_REQUIRED');
    if (prompt.length > PROMPT_MAX) throw httpError(400, 'PROMPT_TOO_LONG');
    const providerId = String(body.provider || doc.provider || '').trim().toLowerCase();
    const { spec, key, apiKey } = await resolveKey(req.user._id, providerId);
    const model = cleanModel(body.model) || doc.model || key.model || llm.DEFAULT_MODELS[spec.id] || '';
    if (!model) throw httpError(400, 'MODEL_INVALID');

    const messages = buildMessages({ kind: doc.kind, files: doc.files, history: doc.messages, prompt, previewError });
    bus.publish(req.user._id, 'project.generating', { id: String(doc._id), state: 'start', prompt: prompt.slice(0, 200) }, { fromDevice: req.get('x-device-id') });
    genStarted = String(doc._id);

    if (wantsStream) {
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      streaming = true;
      send('start', { provider: spec.id, model });
      heartbeat = setInterval(() => {
        res.write(': ping\n\n');
        if (typeof res.flush === 'function') res.flush();
      }, 15_000);
    }

    let result;
    try {
      result = await llm.streamChat({
        provider: spec.id,
        apiKey,
        baseUrl: key.baseUrl,
        model,
        messages,
        signal: controller.signal,
        onDelta: wantsStream ? (text) => send('delta', { text }) : undefined,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        if (res.writableEnded || res.destroyed) return undefined;
        throw httpError(504, 'PROVIDER_TIMEOUT');
      }
      if (err.code && MESSAGES[err.code]) {
        const e = httpError(err.status && err.status < 500 ? 400 : 502, err.code);
        e.message = err.message;
        throw e;
      }
      throw err;
    }

    const fresh = await findOwned(req);
    const outcome = applyGeneration(fresh, { prompt, previewError, text: result.text, provider: spec.id, model, durationMs: Date.now() - generationStartedAt });
    await fresh.save();
    ProviderApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});

    const payload = {
      project: publicProject(fresh, true),
      touched: outcome.touched,
      rejected: outcome.rejected,
      truncated: outcome.truncated || result.finishReason === 'length',
    };
    if (streaming) {
      send('done', payload);
      return res.end();
    }
    return res.json(payload);
  } catch (err) {
    if (err && err.status && err.code) return fail(err);
    if (streaming) return fail(err);
    return next(err);
  } finally {
    clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    running.delete(userId);
    if (genStarted) bus.publish(req.user._id, 'project.generating', { id: genStarted, state: 'end' });
  }
});

// ---------- local provider (browser -> http://localhost OpenAI-compatible endpoint) ----------
// The server cannot reach the user's localhost, so the browser calls the model itself.
// These two routes only build the prompt and apply the reply; no key or local URL is ever sent here.

function readLocalPrompt(body) {
  const prompt = String(body.prompt || '').trim();
  const previewError = String(body.previewError || '').trim().slice(0, 2000);
  if (!prompt && !previewError) throw httpError(400, 'PROMPT_REQUIRED');
  if (prompt.length > PROMPT_MAX) throw httpError(400, 'PROMPT_TOO_LONG');
  return { prompt, previewError };
}

/** POST /v1/builder/projects/:id/local-prompt — body { prompt, previewError? } → { messages } */
router.post(
  '/projects/:id/local-prompt',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    const { prompt, previewError } = readLocalPrompt(req.body || {});
    const messages = buildMessages({ kind: doc.kind, files: doc.files, history: doc.messages, prompt, previewError });
    res.json({ messages });
  })
);

/** POST /v1/builder/projects/:id/local-apply — body { prompt, previewError?, text, model, finishReason? } */
router.post(
  '/projects/:id/local-apply',
  wrap(async (req, res) => {
    const body = req.body || {};
    const { prompt, previewError } = readLocalPrompt(body);
    const text = String(body.text || '');
    if (!text.trim()) throw httpError(502, 'EMPTY_OUTPUT');
    if (text.length > LOCAL_TEXT_MAX) throw httpError(413, 'OUTPUT_TOO_LARGE');
    const model = cleanModel(body.model) || 'local';
    const doc = await findOwned(req);
    const outcome = applyGeneration(doc, { prompt, previewError, text, provider: LOCAL_PROVIDER, model, durationMs: body.durationMs });
    await doc.save();
    res.json({
      project: publicProject(doc, true),
      touched: outcome.touched,
      rejected: outcome.rejected,
      truncated: outcome.truncated || body.finishReason === 'length',
    });
  })
);

module.exports = router;
module.exports.applyGeneration = applyGeneration;
module.exports.publicProject = publicProject;
module.exports.MESSAGES = MESSAGES;
module.exports.errorBody = errorBody;
module.exports.newPreviewToken = newPreviewToken;
module.exports.maxProjects = maxProjects;
