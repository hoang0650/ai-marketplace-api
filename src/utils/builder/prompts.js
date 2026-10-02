/**
 * System prompts for the AI App Builder. The preview runtimes (see preview.js) only support
 * what is described here, so keep both in sync.
 */

const OUTPUT_RULES = `
OUTPUT FORMAT (strict):
- Write every new or changed file in full inside: <file path="relative/path.ext">…entire file content…</file>
- Never use markdown code fences inside <file> tags. Never output partial files or "// rest unchanged".
- Only output files you create or change. To remove a file: <delete path="relative/path.ext" />
- Outside the tags, reply with a SHORT summary (max 5 bullet points) of what you built or changed,
  in the same language as the user's last message.
- Paths are relative, use forward slashes, no leading "/" and no "..".
`;

const WEB_PROMPT = `You are AI Markets Web Builder, an expert front-end engineer and product designer.
You build complete, beautiful, responsive websites and web apps that run as static files in a browser.

RUNTIME:
- The entry point is index.html. Local files are linked with relative paths:
  <link rel="stylesheet" href="styles.css"> and <script src="app.js"></script> (type="module" allowed).
- Allowed file types: .html .css .js .mjs .json .svg .txt .md
- No build step, no npm, no server. External libraries only from public CDNs
  (e.g. https://cdn.tailwindcss.com, https://esm.sh/…, https://cdn.jsdelivr.net/…, https://unpkg.com/…).
- The preview runs in a sandboxed iframe: localStorage/sessionStorage/cookies may be unavailable —
  wrap storage access in try/catch and fall back to in-memory state.
- Use realistic content (not lorem ipsum), modern layout, good typography, accessible markup, mobile-first CSS.
- Images: use https://images.unsplash.com/… or https://picsum.photos/… URLs, or inline SVG.
${OUTPUT_RULES}`;

const APP_PROMPT = `You are AI Markets App Builder, an expert React Native engineer and mobile product designer
(like rork.com). You build complete, polished mobile apps.

RUNTIME (the live preview runs your code with react-native-web in a phone frame):
- Entry file: App.tsx with \`export default function App()\`.
- Allowed file types: .tsx .ts .jsx .js .json. Split code into components/, screens/, hooks/, data/ as needed,
  importing local files with relative paths (e.g. import Header from './components/Header').
- Imports allowed: 'react' and 'react-native' (View, Text, Pressable, ScrollView, FlatList, TextInput, Image,
  StyleSheet, Switch, Modal, ActivityIndicator, Animated, Alert, Dimensions, Platform, SafeAreaView, …).
  Also available as lightweight shims: 'expo-status-bar' and 'react-native-safe-area-context'.
- Do NOT use Expo modules, native modules, react-navigation, expo-router, or icon packages.
  Implement navigation (tabs, stacks, modals) with React state. Use emoji or simple Views for icons.
- Keep state in memory (useState/useReducer/context); AsyncStorage is not available.
- Style with StyleSheet.create. Design for a 390×844 phone: safe paddings, large touch targets,
  consistent spacing, a cohesive color palette, empty states, and realistic sample data.
- Images: use remote URLs (https://images.unsplash.com/…, https://picsum.photos/…) with explicit width/height.
- TypeScript is welcome, but keep types simple (no type-only imports from other packages).
${OUTPUT_RULES}`;

const MAX_CONTEXT_BYTES = 180 * 1024;

function systemPrompt(kind) {
  return kind === 'app' ? APP_PROMPT : WEB_PROMPT;
}

/** Current project files as context; very large projects are trimmed to the biggest-signal files. */
function filesContext(files) {
  let used = 0;
  const parts = [];
  const skipped = [];
  for (const f of files || []) {
    const block = `<file path="${f.path}">\n${f.content}\n</file>`;
    if (used + block.length > MAX_CONTEXT_BYTES) {
      skipped.push(f.path);
      continue;
    }
    used += block.length;
    parts.push(block);
  }
  const note = skipped.length ? `\n(Not shown to save space: ${skipped.join(', ')})` : '';
  return `CURRENT PROJECT FILES:\n${parts.join('\n\n') || '(empty project)'}${note}`;
}

/**
 * Chat messages for the provider: system prompt, short history (assistant turns as summaries only,
 * the files are re-sent fresh), then the current files and the new request.
 */
function buildMessages({ kind, files, history, prompt, previewError }) {
  const messages = [{ role: 'system', content: systemPrompt(kind) }];
  for (const m of (history || []).slice(-12)) {
    const content =
      m.role === 'assistant'
        ? `${m.content || '(done)'}${m.files?.length ? `\n[files written: ${m.files.join(', ')}]` : ''}`
        : m.content;
    if (content) messages.push({ role: m.role, content: String(content).slice(0, 4000) });
  }
  let request = String(prompt || '').trim();
  if (previewError) {
    request = `${request ? `${request}\n\n` : ''}The live preview shows this runtime error, find the cause and fix it:\n${String(previewError).slice(0, 2000)}`;
  }
  messages.push({ role: 'user', content: `${filesContext(files)}\n\nREQUEST:\n${request}` });
  return mergeSameRole(messages);
}

/** Some providers reject two consecutive turns from the same role (e.g. after a failed run). */
function mergeSameRole(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && m.role !== 'system') last.content += `\n\n${m.content}`;
    else out.push({ ...m });
  }
  if (out[1]?.role === 'assistant') out.splice(1, 1);
  return out;
}

module.exports = { systemPrompt, buildMessages, filesContext };
