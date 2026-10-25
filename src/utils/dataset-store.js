/**
 * Splits of an online-only dataset, parsed server-side from the product's stored files
 * (ContentEpisode rows). Buyers only ever see pages of rows, never the files.
 */
const ContentEpisode = require('../models/ContentEpisode');
const minio = require('../config/minio');

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_BYTES = 160 * 1024 * 1024;
const cache = new Map(); // objectName -> { rows: string[] | object[], bytes, columns }
let cacheBytes = 0;

function splitName(filename) {
  const base = String(filename || '').split(/[\\/]/).pop();
  const m = /^(.*)\.(jsonl|csv|json)$/i.exec(base);
  if (!m) return null;
  return { stem: m[1].toLowerCase().replace(/[^a-z0-9_.-]+/g, '_'), ext: m[2].toLowerCase() };
}

/** Data files only: jsonl preferred over csv with the same stem; json only when it is a top-level array. */
function pickSplitFiles(episodes) {
  const by = new Map();
  const rank = { jsonl: 3, csv: 2, json: 1 };
  for (const e of episodes) {
    if (!e.objectName) continue;
    const n = splitName(e.title);
    if (!n) continue;
    if (/^(labels|sha256sums|manifest|package)$/i.test(n.stem)) continue;
    const prev = by.get(n.stem);
    if (!prev || rank[n.ext] > rank[prev.ext]) by.set(n.stem, { ...n, episode: e });
  }
  return [...by.values()];
}

/** `train` matches `train` or `<prefix>_train` when unambiguous. */
function resolveSplit(files, name) {
  const want = String(name || 'train').toLowerCase();
  const exact = files.find((f) => f.stem === want);
  if (exact) return exact;
  const suffix = files.filter((f) => f.stem.endsWith(`_${want}`));
  return suffix.length === 1 ? suffix[0] : null;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = (rows.shift() || []).map((h, i) => (i === 0 ? h.replace(/^\uFEFF/, '') : h));
  return { columns: header, rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) };
}

async function readObject(objectName) {
  const chunks = [];
  let total = 0;
  for await (const c of await minio.getContentObjectStream(objectName)) {
    total += c.length;
    if (total > MAX_FILE_BYTES) throw Object.assign(new Error('Dataset split too large to serve online'), { status: 413, code: 'SPLIT_TOO_LARGE' });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function parseFile(ext, buf) {
  const text = buf.toString('utf8');
  if (ext === 'jsonl') {
    const rows = text.split(/\r?\n/).filter((l) => l.trim());
    let columns = [];
    try {
      columns = Object.keys(JSON.parse(rows[0] || '{}'));
    } catch {
      columns = [];
    }
    return { rows, columns, raw: true };
  }
  if (ext === 'csv') return { ...parseCsv(text), raw: false };
  const doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!Array.isArray(doc)) return null;
  return { rows: doc, columns: doc[0] && typeof doc[0] === 'object' ? Object.keys(doc[0]) : [], raw: false };
}

function remember(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  cacheBytes += entry.bytes;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES || k === key) break;
    cache.delete(k);
    cacheBytes -= v.bytes;
  }
}

async function loadSplit(file) {
  const key = `${file.episode.objectName}|${file.episode.updatedAt ? new Date(file.episode.updatedAt).getTime() : 0}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const buf = await readObject(file.episode.objectName);
  const parsed = parseFile(file.ext, buf);
  if (!parsed) return null;
  const entry = { ...parsed, bytes: buf.length * 2 };
  remember(key, entry);
  return entry;
}

function rowAt(entry, i) {
  const r = entry.rows[i];
  if (!entry.raw) return r;
  try {
    return JSON.parse(r);
  } catch {
    return { value: r };
  }
}

async function datasetFiles(productId) {
  const episodes = await ContentEpisode.find({ product: productId, published: true }).sort({ index: 1 }).lean();
  return { episodes, splits: pickSplitFiles(episodes) };
}

async function readTextFile(episode, maxBytes = 256 * 1024) {
  if (!episode?.objectName) return '';
  const buf = await readObject(episode.objectName);
  return buf.subarray(0, maxBytes).toString('utf8');
}

module.exports = { splitName, pickSplitFiles, resolveSplit, parseCsv, parseFile, loadSplit, rowAt, datasetFiles, readTextFile, _cache: cache };
