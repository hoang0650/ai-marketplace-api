const crypto = require('crypto');
const { jwtSecret } = require('../config/env');

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PER_MESSAGE = 10;

/** ext → [mime served, kind, magic check]. Anything else (exe, js, html, svg, apk…) is refused. */
const ZIP = (b) => b[0] === 0x50 && b[1] === 0x4b;
const OLE = (b) => b.slice(0, 4).toString('hex') === 'd0cf11e0';
const TYPES = {
  png: ['image/png', 'image', (b) => b.slice(0, 4).toString('hex') === '89504e47'],
  jpg: ['image/jpeg', 'image', (b) => b[0] === 0xff && b[1] === 0xd8],
  jpeg: ['image/jpeg', 'image', (b) => b[0] === 0xff && b[1] === 0xd8],
  webp: ['image/webp', 'image', (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP'],
  gif: ['image/gif', 'image', (b) => b.slice(0, 3).toString() === 'GIF'],
  pdf: ['application/pdf', 'file', (b) => b.slice(0, 5).toString() === '%PDF-'],
  zip: ['application/zip', 'file', ZIP],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'file', ZIP],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'file', ZIP],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'file', ZIP],
  doc: ['application/msword', 'file', OLE],
  xls: ['application/vnd.ms-excel', 'file', OLE],
  ppt: ['application/vnd.ms-powerpoint', 'file', OLE],
  '7z': ['application/x-7z-compressed', 'file', (b) => b.slice(0, 6).toString('hex') === '377abcaf271c'],
  txt: ['text/plain', 'file', null],
  csv: ['text/csv', 'file', null],
  md: ['text/markdown', 'file', null],
  json: ['application/json', 'file', null],
  mp4: ['video/mp4', 'file', (b) => b.slice(4, 8).toString() === 'ftyp'],
  mp3: ['audio/mpeg', 'file', (b) => b.slice(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
};
const ALLOWED_EXT = Object.keys(TYPES);

function isExecutable(b) {
  const h = b.slice(0, 4);
  return (
    (h[0] === 0x4d && h[1] === 0x5a) || // MZ (Windows PE)
    h.toString('hex') === '7f454c46' || // ELF
    ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(h.toString('hex')) || // Mach-O / Java
    h.slice(0, 2).toString() === '#!'
  );
}

function looksText(b) {
  const n = Math.min(b.length, 8192);
  for (let i = 0; i < n; i += 1) if (b[i] === 0) return false;
  return !/<\s*(script|html|iframe|svg)/i.test(b.slice(0, n).toString('utf8'));
}

function safeName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().normalize('NFC');
  return base.replace(/[\u0000-\u001f"<>|*?:]+/g, '_').replace(/^\.+/, '').slice(0, 180) || 'file';
}

/** Validate an uploaded buffer. Returns { ext, mime, kind, name } or throws a coded error. */
function inspectFile(buffer, originalName) {
  const err = (code, status = 400) => Object.assign(new Error(code), { status, code });
  if (!buffer || !buffer.length) throw err('NO_FILE');
  if (buffer.length > MAX_BYTES) throw err('FILE_TOO_LARGE', 413);
  const name = safeName(originalName);
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  const type = ext && TYPES[ext];
  if (!type) throw err('FILE_TYPE_NOT_ALLOWED', 415);
  if (isExecutable(buffer)) throw err('FILE_TYPE_NOT_ALLOWED', 415);
  const [mime, kind, magic] = type;
  if (magic ? !magic(buffer) : !looksText(buffer)) throw err('FILE_CONTENT_MISMATCH', 415);
  return { ext, mime, kind, name };
}

function sign(id, exp) {
  return crypto.createHmac('sha256', `${jwtSecret}:attachments`).update(`${id}.${exp}`).digest('base64url').slice(0, 32);
}

/** Short-lived download link handed only to people who already passed the access check. */
function signedPath(id, ttlSeconds = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `/v1/attachments/${id}/raw?exp=${exp}&sig=${sign(String(id), exp)}`;
}

function verifySig(id, exp, sig) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000) return false;
  const want = Buffer.from(sign(String(id), e));
  const got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function publicAttachment(a, base = '') {
  if (!a) return null;
  const id = String(a._id || a.id);
  const url = `${base}${signedPath(id)}`;
  return { id, name: a.name, mime: a.mime, size: a.size, kind: a.kind, url, downloadUrl: `${url}&dl=1` };
}

module.exports = { MAX_BYTES, MAX_PER_MESSAGE, ALLOWED_EXT, inspectFile, signedPath, verifySig, publicAttachment, safeName, isExecutable };
