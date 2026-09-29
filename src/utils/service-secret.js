const crypto = require('crypto');

/** Shared secret used by the OpenClaw gateway plugins when calling this API. */
function expectedServiceSecret() {
  return String(
    process.env.AIMARKETS_SERVICE_SECRET ||
      process.env.NEST_SERVICE_AUTH_SECRET ||
      process.env.PYTHON_AI_SHARED_SECRET ||
      ''
  ).trim();
}

function serviceSecretOk(req) {
  const expected = expectedServiceSecret();
  if (!expected) return false;
  const got = String(req.headers['x-service-secret'] || '').trim();
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { serviceSecretOk, expectedServiceSecret };
