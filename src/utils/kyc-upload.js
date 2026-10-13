/**
 * eKYC upload validation.
 *  - ID front/back: images (jpeg/png/webp), max 8MB, magic bytes checked.
 *  - Business registration certificate (side "license"): PDF only, max 10MB, must start with %PDF.
 */
const IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const PDF_MIME = 'application/pdf';
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const PDF_MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_MAX_BYTES = Math.max(IMAGE_MAX_BYTES, PDF_MAX_BYTES);

function isPdfBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return '';
}

/** Multer pre-filter: only images or PDFs reach the route; per-side rules are in validateKycDocument. */
function isAllowedUploadMime(mime) {
  return IMAGE_MIMES.includes(mime) || mime === PDF_MIME;
}

/**
 * @returns {{ok:true, contentType:string} | {ok:false, status:number, code:string, message:string}}
 */
function validateKycDocument(side, file) {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) {
    return { ok: false, status: 400, code: 'NO_FILE', message: 'No file uploaded' };
  }
  const size = file.size || file.buffer.length;
  if (side === 'license') {
    if (file.mimetype !== PDF_MIME || !isPdfBuffer(file.buffer)) {
      return {
        ok: false,
        status: 400,
        code: 'LICENSE_MUST_BE_PDF',
        message: 'The business registration certificate must be a PDF file',
      };
    }
    if (size > PDF_MAX_BYTES) {
      return { ok: false, status: 413, code: 'FILE_TOO_LARGE', message: 'PDF must be 10MB or smaller' };
    }
    return { ok: true, contentType: PDF_MIME };
  }
  const sniffed = sniffImageMime(file.buffer);
  if (!IMAGE_MIMES.includes(file.mimetype) || !sniffed) {
    return { ok: false, status: 400, code: 'INVALID_IMAGE', message: 'ID photos must be jpeg, png or webp images' };
  }
  if (size > IMAGE_MAX_BYTES) {
    return { ok: false, status: 413, code: 'FILE_TOO_LARGE', message: 'Image must be 8MB or smaller' };
  }
  return { ok: true, contentType: sniffed };
}

module.exports = {
  IMAGE_MIMES,
  PDF_MIME,
  IMAGE_MAX_BYTES,
  PDF_MAX_BYTES,
  UPLOAD_MAX_BYTES,
  isPdfBuffer,
  sniffImageMime,
  isAllowedUploadMime,
  validateKycDocument,
};
