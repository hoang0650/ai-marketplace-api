/**
 * File rules for AI App Builder projects: allowed paths, size caps, parsing the model's
 * `<file path="…">…</file>` output and applying it to a project.
 */

const KIND_EXTS = {
  web: ['html', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'md'],
  app: ['js', 'jsx', 'ts', 'tsx', 'json', 'md'],
};

const PATH_RE = /^(?!.*\.\.)(?!\/)[A-Za-z0-9_\-./]{1,120}$/;

function limits() {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    maxFiles: num(process.env.BUILDER_MAX_FILES, 60),
    fileMaxBytes: num(process.env.BUILDER_FILE_MAX_KB, 200) * 1024,
    projectMaxBytes: num(process.env.BUILDER_PROJECT_MAX_KB, 1024) * 1024,
  };
}

function httpError(status, code, extra) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  if (extra) err.extra = extra;
  return err;
}

function extOf(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path || '');
  return m ? m[1].toLowerCase() : '';
}

/** Normalised safe relative path, or '' when not allowed for this project kind. */
function cleanPath(kind, raw) {
  const path = String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
  if (!PATH_RE.test(path) || path.endsWith('/')) return '';
  if (path.split('/').some((seg) => !seg || seg.startsWith('.'))) return '';
  if (!(KIND_EXTS[kind] || []).includes(extOf(path))) return '';
  return path;
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

/**
 * Model output protocol:
 *   <file path="App.tsx">…full content…</file>
 *   <delete path="old.js" />
 * Everything outside the tags is the assistant's chat reply.
 * An unterminated final <file> (output cut by max tokens) is dropped, not half-applied.
 */
function parseOutput(text) {
  const src = String(text || '');
  const files = [];
  const deletes = [];
  const fileRe = /<file\s+path\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/file>/g;
  let m;
  while ((m = fileRe.exec(src))) {
    files.push({ path: m[1], content: stripFence(m[2]) });
  }
  const delRe = /<delete\s+path\s*=\s*["']([^"']+)["']\s*\/?>(?:\s*<\/delete>)?/g;
  while ((m = delRe.exec(src))) deletes.push(m[1]);
  const opened = (src.match(/<file\s+path\s*=/g) || []).length;
  const summary = src
    .replace(fileRe, '')
    .replace(delRe, '')
    .replace(/<file\s+path[\s\S]*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { files, deletes, summary, truncated: opened > files.length };
}

/** Models often wrap file bodies in a markdown fence despite instructions. */
function stripFence(body) {
  let text = String(body || '').replace(/^\n/, '').replace(/\n$/, '');
  const fence = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(text);
  if (fence) text = fence[1];
  return text;
}

/**
 * Returns the new file list plus the paths actually touched. Invalid paths are reported in
 * `rejected` instead of failing the whole turn.
 */
function applyChanges(kind, current, { files = [], deletes = [] }) {
  const lim = limits();
  const map = new Map((current || []).map((f) => [f.path, f.content]));
  const touched = [];
  const rejected = [];
  for (const raw of deletes) {
    const path = cleanPath(kind, raw);
    if (path && map.delete(path)) touched.push(path);
  }
  for (const f of files) {
    const path = cleanPath(kind, f.path);
    if (!path || byteLength(f.content) > lim.fileMaxBytes) {
      rejected.push(String(f.path || '').slice(0, 120));
      continue;
    }
    map.set(path, String(f.content));
    if (!touched.includes(path)) touched.push(path);
  }
  const next = [...map.entries()].map(([path, content]) => ({ path, content }));
  checkProject(next);
  return { files: sortFiles(next), touched, rejected };
}

function checkProject(files) {
  const lim = limits();
  if (files.length > lim.maxFiles) throw httpError(400, 'PROJECT_TOO_MANY_FILES', { max: lim.maxFiles });
  const total = files.reduce((n, f) => n + byteLength(f.content), 0);
  if (total > lim.projectMaxBytes) throw httpError(400, 'PROJECT_TOO_LARGE', { maxBytes: lim.projectMaxBytes });
}

function sortFiles(files) {
  const rank = (p) => (/^(index\.html|App\.(tsx|jsx|ts|js))$/.test(p) ? 0 : p.includes('/') ? 2 : 1);
  return [...files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

const STARTERS = {
  web: [
    {
      path: 'index.html',
      content: `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My web app</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main class="hero">
    <h1>Xin chào 👋</h1>
    <p>Mô tả website bạn muốn ở khung chat bên trái, AI sẽ build ngay tại đây.</p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`,
    },
    {
      path: 'styles.css',
      content: `body { margin: 0; font-family: system-ui, sans-serif; background: #0b1020; color: #e5e7eb; }
.hero { min-height: 100vh; display: grid; place-content: center; text-align: center; padding: 24px; }
h1 { font-size: 2.5rem; margin: 0 0 12px; }
p { color: #94a3b8; max-width: 32rem; }
`,
    },
    { path: 'app.js', content: `console.log('ready');\n` },
  ],
  app: [
    {
      path: 'App.tsx',
      content: `import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Xin chào 👋</Text>
      <Text style={styles.hint}>Mô tả app bạn muốn ở khung chat, AI sẽ build và chạy thử ngay tại đây.</Text>
      <Pressable style={styles.button} onPress={() => setCount((c) => c + 1)}>
        <Text style={styles.buttonText}>Đã bấm {count} lần</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#0b1020' },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 8 },
  hint: { fontSize: 15, color: '#94a3b8', textAlign: 'center', marginBottom: 24 },
  button: { backgroundColor: '#6366f1', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 },
  buttonText: { color: '#fff', fontWeight: '600' },
});
`,
    },
  ],
};

function starterFiles(kind) {
  return (STARTERS[kind] || []).map((f) => ({ ...f }));
}

module.exports = {
  KIND_EXTS,
  limits,
  httpError,
  extOf,
  cleanPath,
  byteLength,
  parseOutput,
  applyChanges,
  checkProject,
  sortFiles,
  starterFiles,
};
