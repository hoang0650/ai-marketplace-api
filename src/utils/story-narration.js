/**
 * Story-book narration segments with real TTS timing (see routes/content.js POST /episodes/:id/narration and
 * the AI service's story_narration job).
 *
 * paragraphs() is an exact port of the web reader's toParagraphs (story-reader.component.ts) for plain text, so a
 * segment's { p, c0, c1 } offsets index straight into the paragraphs the reader renders. paraSig (FNV-1a of each
 * paragraph, same function in the reader) lets the reader detect a chapter edited after its narration was made
 * and fall back instead of highlighting the wrong words.
 */
const crypto = require('crypto');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** Best-effort server copy of the reader's DOMParser branch (blocks p,h1-4,li,blockquote; text only). */
function htmlText(html) {
  const body = String(html).replace(/<(script|style|template)[\s\S]*?<\/\1>/gi, '');
  const blocks = [];
  const re = /<(p|h[1-4]|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body))) blocks.push(decodeEntities(m[2].replace(/<[^>]+>/g, '')));
  return blocks.length ? blocks.join('\n\n') : decodeEntities(body.replace(/<[^>]+>/g, ''));
}

function paragraphs(raw, type = '') {
  let text = String(raw || '');
  if (/html/i.test(type) || /^\s*</.test(text)) text = htmlText(text);
  return text
    .replace(/\r/g, '')
    .split(/\n\s*\n|\n(?=\s{2,})/)
    .map((p) => p.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** FNV-1a 32-bit over UTF-16 code units, hex. Mirrored in the web reader. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const END = /[.!?…。！？;；]+["'”’»)\]」』]*(?=\s|$)|[。！？]+["'”’»)\]」』]*/g;
const MIN_SENT = 18;
const MAX_SENT = 360;
const SPEAKABLE = /[\p{L}\p{N}]/u;

/** Sentence spans [c0, c1) inside one paragraph; short bits merge forward, long ones split at commas/spaces. */
function sentences(p) {
  const cuts = [];
  END.lastIndex = 0;
  let m;
  while ((m = END.exec(p))) cuts.push(m.index + m[0].length);
  if (!cuts.length || cuts[cuts.length - 1] < p.length) cuts.push(p.length);
  let spans = [];
  let a = 0;
  for (const b of cuts) {
    if (b > a) spans.push([a, b]);
    a = b;
  }
  spans = spans
    .map(([s, e]) => {
      while (s < e && /\s/.test(p[s])) s += 1;
      while (e > s && /\s/.test(p[e - 1])) e -= 1;
      return [s, e];
    })
    .filter(([s, e]) => e > s);
  const merged = [];
  for (const sp of spans) {
    const prev = merged[merged.length - 1];
    if (prev && prev[1] - prev[0] < MIN_SENT) prev[1] = sp[1];
    else merged.push([...sp]);
  }
  const last = merged[merged.length - 1];
  if (merged.length > 1 && last[1] - last[0] < MIN_SENT) merged[merged.length - 2][1] = merged.pop()[1];
  const out = [];
  for (let [s, e] of merged) {
    while (e - s > MAX_SENT) {
      const win = p.slice(s, s + MAX_SENT);
      let cut = Math.max(win.lastIndexOf(', '), win.lastIndexOf('; '), win.lastIndexOf('，'), win.lastIndexOf('、'));
      if (cut < MAX_SENT / 3) cut = win.lastIndexOf(' ');
      if (cut < MAX_SENT / 3) cut = MAX_SENT - 1;
      out.push([s, s + cut + 1]);
      s += cut + 1;
      while (s < e && /\s/.test(p[s])) s += 1;
    }
    if (e > s) out.push([s, e]);
  }
  return out.map(([s, e]) => [s, e - (/\s/.test(p[e - 1]) ? 1 : 0)]);
}

/** Chapter text -> { paras, paraSig, segments: [{ id, p, c0, c1, text }] } (only speakable segments). */
function segment(raw, type = '') {
  const paras = paragraphs(raw, type);
  const segments = [];
  paras.forEach((p, pi) => {
    for (const [c0, c1] of sentences(p)) {
      const text = p.slice(c0, c1);
      if (SPEAKABLE.test(text)) segments.push({ id: String(segments.length), p: pi, c0, c1, text });
    }
  });
  return { paras, paraSig: paras.map(fnv), segments };
}

const textHash = (raw) => crypto.createHash('sha256').update(String(raw || '')).digest('hex').slice(0, 32);

module.exports = { paragraphs, sentences, segment, fnv, textHash, htmlText };
