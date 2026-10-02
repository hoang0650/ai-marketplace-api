const zlib = require('zlib');
const { httpError } = require('./files');

/**
 * Minimal ZIP reader for seller template uploads (stored + deflate entries, no ZIP64,
 * no encryption). Caps entry count and inflated size so a zip bomb cannot exhaust memory.
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function isZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 22 && buf.readUInt32LE(0) === LOCAL_SIG;
}

/** Returns [{ path, data }] for file entries (directories skipped). */
function readZip(buf, { maxEntries = 500, maxTotalBytes = 8 * 1024 * 1024 } = {}) {
  const eocd = isZip(buf) ? findEocd(buf) : -1;
  if (eocd < 0) throw httpError(400, 'ZIP_INVALID');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw httpError(400, 'ZIP_UNSUPPORTED');
  if (count > maxEntries) throw httpError(400, 'ZIP_TOO_MANY_FILES', { max: maxEntries });

  const out = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) throw httpError(400, 'ZIP_INVALID');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw httpError(400, 'ZIP_ENCRYPTED');
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw httpError(400, 'ZIP_INVALID');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compSize > buf.length) throw httpError(400, 'ZIP_INVALID');

    total += size;
    if (total > maxTotalBytes) throw httpError(400, 'ZIP_TOO_LARGE', { maxBytes: maxTotalBytes });
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw httpError(400, 'ZIP_INVALID');
      }
    } else throw httpError(400, 'ZIP_UNSUPPORTED');
    out.push({ path: name, data });
  }
  return out;
}

module.exports = { readZip, isZip };
