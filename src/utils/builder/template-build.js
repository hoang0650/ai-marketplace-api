const Babel = require('@babel/standalone');
const tpl = require('./templates');

/**
 * "Build" for seller templates: the same checks the sandboxed preview would trip over, run
 * before the template goes on sale. Web: references to local scripts/styles resolve and JS
 * parses. App: every module compiles with the preview's Babel config, relative imports
 * resolve and App exports a component. Returns a Dokploy-style log instead of throwing.
 */

const APP_EXTERNALS = new Set(['react', 'react-native', 'expo-status-bar', 'react-native-safe-area-context']);
const MAX_SKIP_LINES = 20;

function createLog() {
  const started = Date.now();
  const lines = [];
  const push = (level, msg) => {
    lines.push({ t: Date.now() - started, level, msg: String(msg).slice(0, 2000) });
  };
  return {
    lines,
    started,
    info: (m) => push('info', m),
    warn: (m) => push('warn', m),
    error: (m) => push('error', m),
    success: (m) => push('success', m),
    errors: () => lines.filter((l) => l.level === 'error').length,
  };
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function joinPath(from, spec) {
  const parts = spec.startsWith('/') ? [] : dirOf(from).split('/').filter(Boolean);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function isExternalRef(ref) {
  return !ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\$\{)/i.test(ref);
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Babel messages already carry "(line:col)" and a code frame; keep them readable in a log. */
function babelMessage(path, err) {
  const msg = String(err?.message || err || 'error').replace(/^\/?unknown:\s*/, '');
  return msg.startsWith(path) ? msg : `${path}: ${msg}`;
}

const REF_RES = [
  { re: /<script\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi, kind: 'script', fatal: true },
  { re: /<link\b[^>]*?\shref\s*=\s*["']([^"']+)["'][^>]*>/gi, kind: 'link', fatal: false },
  { re: /<(?:img|source|video|audio)\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi, kind: 'asset', fatal: false },
  { re: /<a\b[^>]*?\shref\s*=\s*["']([^"']+\.html?)(?:[?#][^"']*)?["']/gi, kind: 'page', fatal: false },
];

function checkWeb(files, log) {
  const map = new Map(files.map((f) => [f.path, f.content]));
  const index = map.get('index.html') || '';
  if (!/<body[\s>]/i.test(index)) log.warn('index.html: không thấy thẻ <body> — trình duyệt vẫn hiển thị nhưng nên dùng HTML đầy đủ.');

  for (const f of files.filter((x) => /\.html?$/i.test(x.path))) {
    for (const { re, kind, fatal } of REF_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(f.content))) {
        const raw = m[1].trim();
        if (isExternalRef(raw)) continue;
        if (kind === 'link' && !/rel\s*=\s*["'][^"']*(stylesheet|icon|manifest)/i.test(m[0])) continue;
        const target = joinPath(f.path, raw.split(/[?#]/)[0]);
        if (map.has(target)) continue;
        const where = `${f.path}:${lineOf(f.content, m.index)}`;
        if (fatal || (kind === 'link' && /stylesheet/i.test(m[0]))) {
          log.error(`${where} tham chiếu "${raw}" nhưng file ${target || raw} không có trong template.`);
        } else if (kind === 'asset') {
          log.warn(`${where} ảnh/media "${raw}" không có trong template (file nhị phân bị bỏ qua) — hãy dùng URL https://.`);
        } else {
          log.warn(`${where} liên kết "${raw}" trỏ tới file không có trong template.`);
        }
      }
    }
  }

  for (const f of files.filter((x) => /\.(m?js)$/i.test(x.path))) {
    try {
      Babel.transform(f.content, { filename: f.path, sourceType: 'unambiguous', babelrc: false, configFile: false, code: false });
    } catch (err) {
      log.error(babelMessage(f.path, err));
    }
  }
}

function resolveModule(compiled, from, spec) {
  const p = joinPath(from, spec);
  const tries = [p, `${p}.tsx`, `${p}.ts`, `${p}.jsx`, `${p}.js`, `${p}.json`, `${p}/index.tsx`, `${p}/index.ts`, `${p}/index.jsx`, `${p}/index.js`];
  return tries.find((c) => compiled.has(c)) || '';
}

function checkApp(files, log) {
  const compiled = new Map();
  for (const f of files) {
    if (/\.json$/i.test(f.path)) {
      compiled.set(f.path, '');
      continue;
    }
    if (!/\.(tsx|ts|jsx|js)$/i.test(f.path)) continue;
    try {
      const out = Babel.transform(f.content, {
        filename: f.path,
        sourceType: 'module',
        babelrc: false,
        configFile: false,
        presets: [['react', { runtime: 'classic' }], 'typescript'],
        plugins: ['transform-modules-commonjs'],
      });
      compiled.set(f.path, out.code || '');
    } catch (err) {
      compiled.set(f.path, null);
      log.error(babelMessage(f.path, err));
    }
  }

  const packages = new Set();
  for (const [path, code] of compiled) {
    if (!code) continue;
    for (const m of code.matchAll(/require\("([^"]+)"\)/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/')) {
        if (!resolveModule(compiled, path, spec)) log.error(`${path}: Cannot find module '${spec}' — file không có trong template.`);
      } else if (!APP_EXTERNALS.has(spec)) {
        packages.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
      }
    }
  }
  for (const name of packages) {
    log.warn(`Package "${name}" không có sẵn trong preview, sẽ tải từ esm.sh lúc chạy — có thể lỗi. Nên chỉ dùng react / react-native.`);
  }

  const entry = tpl.ENTRY.app.find((p) => compiled.has(p));
  const entryCode = entry ? compiled.get(entry) : null;
  if (entryCode && !/exports\.default\s*=/.test(entryCode)) {
    log.error(`${entry}: thiếu "export default" — preview cần component mặc định (vd. export default function App() {...}).`);
  }
}

/**
 * entries: [{ path, data }] as fetched (null when fetching already failed and was logged);
 * dropped: skips reported by the fetch stage. describe(err) turns a builder error into text.
 * @returns {{ ok: boolean, files: Array<{path, content}>, skipped: Array, log: Array, durationMs: number }}
 */
function runBuild({ kind, entries, dropped = [], describe = (e) => e.message }, log = createLog()) {
  let files = [];
  let skipped = [...dropped];
  if (entries) {
    log.info(`Đã tải ${entries.length} file${dropped.length ? `, bỏ qua ${dropped.length} file` : ''}.`);
    for (const s of dropped.slice(0, MAX_SKIP_LINES)) log.warn(`Bỏ qua ${s.path} (${s.reason}).`);
    if (dropped.length > MAX_SKIP_LINES) log.warn(`… và ${dropped.length - MAX_SKIP_LINES} file khác.`);
    log.info('Kiểm tra cấu trúc template…');
    try {
      const norm = tpl.normalizeUpload(kind, entries);
      files = norm.files;
      skipped = [...dropped, ...norm.skipped];
      for (const s of norm.skipped.slice(0, MAX_SKIP_LINES)) log.warn(`Bỏ qua ${s.path} (${s.reason}).`);
      log.info(`Template có ${files.length} file, file chính: ${files[0]?.path || '—'}.`);
    } catch (err) {
      log.error(describe(err));
      for (const s of (err.extra?.skipped || []).slice(0, MAX_SKIP_LINES)) log.warn(`Bỏ qua ${s.path} (${s.reason}).`);
    }
  }

  if (files.length) {
    log.info(kind === 'app' ? 'Biên dịch React Native (Babel: react + typescript)…' : 'Kiểm tra HTML / CSS / JS…');
    if (kind === 'app') checkApp(files, log);
    else checkWeb(files, log);
  }

  if (!files.length && !log.errors()) log.error('Không lấy được file nào từ nguồn.');
  const errors = log.errors();
  const durationMs = Date.now() - log.started;
  if (errors) {
    log.error(`Build thất bại với ${errors} lỗi (${(durationMs / 1000).toFixed(1)}s). Sửa trong repo rồi bấm Build lại.`);
    return { ok: false, files: [], skipped, log: log.lines, durationMs };
  }
  log.success(`Build thành công (${(durationMs / 1000).toFixed(1)}s) — ${files.length} file sẵn sàng để đăng bán.`);
  return { ok: true, files, skipped, log: log.lines, durationMs };
}

module.exports = { runBuild, createLog, checkWeb, checkApp };
