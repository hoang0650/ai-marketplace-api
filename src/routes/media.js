const express = require('express');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { verifyMediaLink, openUpstream } = require('../utils/media-rehost');

const router = express.Router();

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
const INLINE_TYPE_RE = /^(image|video|audio)\//i;

/** GET /v1/media/:token — stream a signed generated-media link from our own domain. */
router.get('/:token', async (req, res, next) => {
  const url = verifyMediaLink(req.params.token);
  if (!url) return res.status(404).json({ message: 'Link expired or invalid', code: 'MEDIA_LINK_INVALID' });
  try {
    const headers = {};
    if (req.headers.range) headers.Range = String(req.headers.range).slice(0, 100);
    const upstream = await openUpstream(url, { headers, timeoutMs: 10 * 60_000 });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => {});
      return res.status(upstream.status === 404 ? 404 : 502).json({ message: 'Media unavailable', code: 'MEDIA_UNAVAILABLE' });
    }

    res.status(upstream.status);
    for (const key of PASS_HEADERS) {
      const v = upstream.headers.get(key);
      if (v) res.setHeader(key, v);
    }
    const type = String(upstream.headers.get('content-type') || '');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (!INLINE_TYPE_RE.test(type)) {
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    }
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (res.headersSent) return res.destroy(err);
    if (err.code === 'UNSAFE_URL') return res.status(404).json({ message: 'Media unavailable', code: 'MEDIA_UNAVAILABLE' });
    return next(err);
  }
});

module.exports = router;
