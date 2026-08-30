const config = require('../config/env');

function notFound(req, res) {
  res.status(404).json({ message: `Route missing: ${req.method} ${req.originalUrl}` });
}

/** Map known error types to safe HTTP responses. */
function resolveError(err) {
  // Mongoose validation → 400 with field messages
  if (err.name === 'ValidationError' && err.errors) {
    const details = Object.values(err.errors).map((e) => e.message);
    return { status: 400, message: 'Validation failed', details };
  }
  // Invalid ObjectId / cast → 400
  if (err.name === 'CastError') {
    return { status: 400, message: `Invalid value for "${err.path}"` };
  }
  // Duplicate key → 409
  if (err.code === 11000) {
    const fields = Object.keys(err.keyPattern || {}).join(', ');
    return { status: 409, message: `Duplicate value for: ${fields || 'unique field'}` };
  }
  // Malformed JSON body
  if (err.type === 'entity.parse.failed') {
    return { status: 400, message: 'Malformed JSON body' };
  }
  // Payload too large
  if (err.type === 'entity.too.large') {
    return { status: 413, message: 'Payload too large' };
  }
  const status = err.status || err.statusCode || 500;
  return {
    status,
    code: err.code,
    message:
      status >= 500 && config.isProduction ? 'Internal server error' : err.message || 'Internal server error',
  };
}

function errorHandler(err, req, res, _next) {
  const { status, message, details, code } = resolveError(err);
  if (status >= 500) {
    console.error(`[api] ${req.method} ${req.originalUrl}`, err);
  }
  res.status(status).json({
    message,
    ...(code ? { code } : {}),
    ...(details ? { details } : {}),
    ...(config.nodeEnv === 'development' ? { stack: err.stack } : {}),
  });
}

module.exports = { notFound, errorHandler };
