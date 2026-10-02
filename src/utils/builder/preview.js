const { marketplaceFrameAncestors } = require('../frame-ancestors');

/**
 * Live preview documents for AI App Builder projects. They are served from the API under
 * /v1/builder/preview/:id/:token/ with a CSP sandbox (opaque origin), so generated code can
 * never read AI Markets cookies or storage even when the link is opened directly.
 */

const VERSIONS = {
  react: '18.3.1',
  reactDom: '18.3.1',
  reactNativeWeb: '0.19.13',
};

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

function securityHeaders(isDocument) {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*',
  };
  if (isDocument) {
    headers['Content-Security-Policy'] =
      'sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox; ' +
      `frame-ancestors ${marketplaceFrameAncestors()}`;
  }
  return headers;
}

/** Forwards runtime errors to the builder page (postMessage) and shows them when opened standalone. */
const REPORTER = `<script>
(function () {
  var sent = 0;
  function post(type, message) {
    var data = { source: 'aim-preview', type: type, message: String(message || '').slice(0, 2000) };
    try { if (window.parent !== window) window.parent.postMessage(data, '*'); } catch (e) {}
    try { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(data)); } catch (e) {}
  }
  function overlay(msg) {
    if (window.parent !== window) return;
    var box = document.getElementById('aim-error') || document.createElement('pre');
    box.id = 'aim-error';
    box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;max-height:45%;overflow:auto;margin:0;padding:12px;border-radius:10px;background:#7f1d1d;color:#fff;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;z-index:2147483647';
    box.textContent = msg;
    (document.body || document.documentElement).appendChild(box);
  }
  window.__aimReport = function (err, inline) {
    var msg = (err && (err.stack || err.message)) || String(err);
    if (!msg || msg === 'Script error.') return;
    if (sent++ < 5) post('error', msg);
    if (!inline) overlay(msg);
  };
  window.addEventListener('error', function (e) { window.__aimReport(e.error || e.message); });
  window.addEventListener('unhandledrejection', function (e) { window.__aimReport(e.reason); });
  window.addEventListener('load', function () { post('ready', ''); });
})();
</script>`;

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** JSON safe to embed inside a <script> element. */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function injectReporter(html) {
  const doc = String(html || '');
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => `${m}\n${REPORTER}`);
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${REPORTER}</head>`);
  return `${REPORTER}\n${doc}`;
}

function emptyPage(project) {
  const items = (project.files || []).map((f) => `<li>${escapeHtml(f.path)}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(project.name)}</title></head>
<body style="font-family:system-ui;padding:24px;color:#334155"><h1 style="font-size:18px">${escapeHtml(project.name)}</h1>
<p>Project chưa có index.html.</p><ul>${items}</ul></body></html>`;
}

/**
 * Resolves one request path of a web project to { status, headers, body }.
 * `relPath` is the part after /preview/:id/:token/ ('' = index.html).
 */
function webResponse(project, relPath) {
  const files = new Map((project.files || []).map((f) => [f.path, f.content]));
  let path = String(relPath || '').replace(/^\/+/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    return { status: 400, headers: securityHeaders(false), body: 'Bad path' };
  }
  if (!path || path.endsWith('/')) path += 'index.html';
  if (!files.has(path) && files.has(`${path}.html`)) path = `${path}.html`;
  if (!files.has(path)) {
    if (path === 'index.html') {
      return { status: 200, headers: { ...securityHeaders(true), 'Content-Type': CONTENT_TYPES.html }, body: emptyPage(project) };
    }
    return { status: 404, headers: { ...securityHeaders(false), 'Content-Type': CONTENT_TYPES.txt }, body: 'Not found' };
  }
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] || '').toLowerCase();
  const type = CONTENT_TYPES[ext] || 'application/octet-stream';
  const isHtml = ext === 'html';
  const body = isHtml ? injectReporter(files.get(path)) : files.get(path);
  return { status: 200, headers: { ...securityHeaders(isHtml || ext === 'svg'), 'Content-Type': type }, body };
}

/** In-browser runtime: Babel compiles the project, react-native-web renders it. */
const APP_IMPORTS = `import * as React from 'react';
import * as RN from 'react-native';`;

const APP_RUNTIME = `
const report = window.__aimReport || ((e) => console.error(e));
const files = JSON.parse(document.getElementById('aim-files').textContent);
const root = document.getElementById('root');
const asModule = (m) => ({ ...m, default: m.default ?? m, __esModule: true });

try {
  RN.Alert.alert = (title, message) => window.alert([title, message].filter(Boolean).join('\\n\\n'));
} catch (e) {}

const passthrough = ({ children }) => children ?? null;
const externals = {
  react: asModule(React),
  'react-native': asModule(RN),
  'expo-status-bar': { __esModule: true, StatusBar: () => null, default: () => null },
  'react-native-safe-area-context': {
    __esModule: true,
    SafeAreaProvider: passthrough,
    SafeAreaView: RN.SafeAreaView || RN.View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
  },
};

const compiled = {};
for (const [path, code] of Object.entries(files)) {
  if (/\\.json$/.test(path)) {
    compiled[path] = { json: code };
  } else if (/\\.(tsx|ts|jsx|js)$/.test(path)) {
    try {
      compiled[path] = {
        code: Babel.transform(code, {
          filename: path,
          sourceType: 'module',
          presets: [['react', { runtime: 'classic' }], 'typescript'],
          plugins: ['transform-modules-commonjs'],
        }).code,
      };
    } catch (e) {
      throw new Error(path + ': ' + e.message);
    }
  }
}

const remote = {};
const bare = new Set();
for (const entry of Object.values(compiled)) {
  for (const m of (entry.code || '').matchAll(/require\\("([^".][^"]*)"\\)/g)) {
    if (!externals[m[1]]) bare.add(m[1]);
  }
}
await Promise.all(
  [...bare].map(async (name) => {
    try {
      remote[name] = asModule(await import('https://esm.sh/' + name + '?external=react,react-dom,react-native'));
    } catch (e) {
      throw new Error("Package '" + name + "' is not available in the preview. Use react / react-native only.");
    }
  }),
);

const cache = {};
function resolve(from, spec) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg) parts.push(seg);
  }
  const p = parts.join('/');
  const tries = [p, p + '.tsx', p + '.ts', p + '.jsx', p + '.js', p + '.json', p + '/index.tsx', p + '/index.ts', p + '/index.jsx', p + '/index.js'];
  const hit = tries.find((c) => compiled[c]);
  if (!hit) throw new Error("Cannot find module '" + spec + "' from " + from);
  return hit;
}
function load(path) {
  if (cache[path]) return cache[path].exports;
  const mod = { exports: {} };
  cache[path] = mod;
  const entry = compiled[path];
  if (entry.json != null) {
    mod.exports = JSON.parse(entry.json);
    return mod.exports;
  }
  const fn = new Function('require', 'module', 'exports', 'React', entry.code + '\\n//# sourceURL=' + path);
  fn((spec) => req(path, spec), mod, mod.exports, React);
  return mod.exports;
}
function req(from, spec) {
  if (spec.startsWith('.')) return load(resolve(from, spec));
  if (externals[spec]) return externals[spec];
  if (remote[spec]) return remote[spec];
  throw new Error("Module '" + spec + "' is not available in the preview");
}

const entry = ['App.tsx', 'App.jsx', 'App.ts', 'App.js', 'index.tsx', 'index.js'].find((p) => compiled[p]);
if (!entry) throw new Error('App.tsx not found');
const App = load(entry).default;
if (typeof App !== 'function') throw new Error(entry + ' must export default a React component');

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    report(new Error((error && error.message) + '\\n' + ((info && info.componentStack) || '').trim().split('\\n').slice(0, 6).join('\\n')));
  }
  render() {
    if (!this.state.error) return React.createElement(App);
    return React.createElement(
      RN.ScrollView,
      { contentContainerStyle: { padding: 20 } },
      React.createElement(RN.Text, { style: { color: '#b91c1c', fontWeight: '700', marginBottom: 8 } }, 'App crashed'),
      React.createElement(RN.Text, { style: { color: '#7f1d1d', fontFamily: 'monospace', fontSize: 12 } }, String(this.state.error.message || this.state.error)),
    );
  }
}

root.textContent = '';
RN.AppRegistry.registerComponent('main', () => Boundary);
RN.AppRegistry.runApplication('main', { rootTag: root });
`;

function appDocument(project) {
  const files = Object.fromEntries((project.files || []).map((f) => [f.path, f.content]));
  const esm = 'https://esm.sh';
  const importMap = {
    imports: {
      react: `${esm}/react@${VERSIONS.react}`,
      'react-dom': `${esm}/react-dom@${VERSIONS.reactDom}?external=react`,
      'react-dom/client': `${esm}/react-dom@${VERSIONS.reactDom}/client?external=react,react-dom`,
      'react-native': `${esm}/react-native-web@${VERSIONS.reactNativeWeb}?external=react,react-dom`,
    },
  };
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(project.name)}</title>
${REPORTER}
<style>
html, body { height: 100%; margin: 0; }
body { background: #fff; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
#root { display: flex; flex-direction: column; height: 100%; }
.aim-loading { margin: auto; color: #94a3b8; font-size: 14px; }
</style>
<script type="importmap">${scriptJson(importMap)}</script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"></script>
<script type="application/json" id="aim-files">${scriptJson(files)}</script>
</head>
<body>
<div id="root"><div class="aim-loading">Đang chạy app…</div></div>
<script type="module">
${APP_IMPORTS}
try {
${APP_RUNTIME}
} catch (e) {
  window.__aimReport(e, true);
  const crash = document.createElement('pre');
  crash.style.cssText = 'margin:16px;color:#b91c1c;white-space:pre-wrap;font:12px/1.4 ui-monospace,monospace';
  crash.textContent = String((e && e.message) || e);
  document.getElementById('root').replaceChildren(crash);
}
</script>
<script>
setTimeout(function () {
  if (document.querySelector('.aim-loading')) window.__aimReport(new Error('Preview runtime did not start (CDN esm.sh / jsdelivr unreachable?)'));
}, 25000);
</script>
</body>
</html>`;
}

/** { status, headers, body } for a preview request. */
function previewResponse(project, relPath) {
  if (project.kind === 'app') {
    const path = String(relPath || '').replace(/^\/+/, '');
    if (path && path !== 'index.html') {
      return { status: 404, headers: { ...securityHeaders(false), 'Content-Type': CONTENT_TYPES.txt }, body: 'Not found' };
    }
    return { status: 200, headers: { ...securityHeaders(true), 'Content-Type': CONTENT_TYPES.html }, body: appDocument(project) };
  }
  return webResponse(project, relPath);
}

module.exports = { previewResponse, appDocument, webResponse, injectReporter, scriptJson, VERSIONS };
