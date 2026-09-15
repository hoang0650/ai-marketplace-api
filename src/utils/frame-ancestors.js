const config = require('../config/env');

function marketplaceFrameAncestors() {
  const origins = new Set(["'self'", 'https://aimarkets.vn', 'https://www.aimarkets.vn']);
  try {
    origins.add(new URL(config.frontendUrl).origin);
  } catch {
    /* ignore */
  }
  for (const raw of config.corsOrigins || []) {
    if (!raw || raw === '*') continue;
    try {
      origins.add(new URL(raw).origin);
    } catch {
      /* ignore */
    }
  }
  return [...origins].join(' ');
}

function isGamePlayerPath(url) {
  return /\/game-sessions\/[^/?]+\/(player|proxy)/i.test(String(url || ''));
}

/** Helmet/Traefik X-Frame-Options: DENY blocks aimarkets.vn from embedding the player. */
function allowMarketplaceGameFrame(req, res, next) {
  if (!isGamePlayerPath(req.originalUrl || req.url)) return next();
  const ancestors = marketplaceFrameAncestors();
  const writeHead = res.writeHead.bind(res);
  res.writeHead = function patchedWriteHead(...args) {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors}`);
    return writeHead(...args);
  };
  next();
}

function setPlayerFrameHeaders(res) {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${marketplaceFrameAncestors()}`);
}

module.exports = {
  marketplaceFrameAncestors,
  isGamePlayerPath,
  allowMarketplaceGameFrame,
  setPlayerFrameHeaders,
};
