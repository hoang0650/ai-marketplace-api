const express = require('express');
const mongoose = require('mongoose');
const { authenticate } = require('../middleware/auth');
const ProviderApiKey = require('../models/ProviderApiKey');
const { sealSecret, openSecret } = require('../utils/secret-box');
const { verifyMarketTicket } = require('../utils/openclaw-ticket');
const { serviceSecretOk } = require('../utils/service-secret');
const {
  getByokProvider,
  publicProviderList,
  normalizeCustomBaseUrl,
  verifyProviderKey,
} = require('../utils/byok-providers');

/**
 * BYOK for AI Markets OpenClaw: buyers store their own provider keys here; the
 * gateway plugin resolves them per run via X-Service-Secret. Keys never leave
 * this API except through /resolve.
 */
const router = express.Router();
const USER_ID_RE = /^[a-f0-9]{24}$/i;
const MAX_KEY_LENGTH = 512;
const LAST_USED_THROTTLE_MS = 10 * 60 * 1000;

/** Buyer auth: marketplace JWT (web) or signed market ticket (OpenClaw Control UI). */
function authenticateBuyer(req, res, next) {
  const ticket = String(req.headers['x-market-ticket'] || '').trim();
  if (ticket) {
    const uid = verifyMarketTicket(ticket);
    if (!uid) {
      return res.status(401).json({
        success: false,
        code: 'MARKET_TICKET_INVALID',
        message: 'Phiên OpenClaw đã hết hạn. Mở lại OpenClaw từ AI Markets.',
      });
    }
    req.buyerId = uid;
    return next();
  }
  return authenticate(req, res, () => {
    req.buyerId = String(req.user?._id || req.user?.id || '').toLowerCase();
    if (!USER_ID_RE.test(req.buyerId)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return next();
  });
}

function requireProvider(req, res) {
  const provider = getByokProvider(req.params.provider);
  if (!provider) {
    res.status(404).json({ success: false, message: 'Provider không được hỗ trợ.' });
    return null;
  }
  return provider;
}

function sanitizeModelId(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.length > 200 || !/^[\w.:/@+-]+$/.test(value)) {
    throw new Error('Tên model không hợp lệ.');
  }
  return value;
}

router.get('/providers', (_req, res) => {
  res.json({ success: true, providers: publicProviderList() });
});

router.get('/keys', authenticateBuyer, async (req, res, next) => {
  try {
    const rows = await ProviderApiKey.find({ user: req.buyerId }).sort({ provider: 1 });
    res.json({ success: true, userId: req.buyerId, keys: rows.map((r) => r.toPublic()) });
  } catch (err) {
    next(err);
  }
});

router.put('/keys/:provider', authenticateBuyer, async (req, res, next) => {
  try {
    const provider = requireProvider(req, res);
    if (!provider) return;
    const existing = await ProviderApiKey.findOne({ user: req.buyerId, provider: provider.id }).select(
      '+secret'
    );
    const apiKeyInput = String(req.body?.apiKey || '').trim();
    if (!apiKeyInput && !existing) {
      return res.status(400).json({ success: false, message: 'Nhập API key.' });
    }
    if (apiKeyInput.length > MAX_KEY_LENGTH || /\s/.test(apiKeyInput)) {
      return res.status(400).json({ success: false, message: 'API key không hợp lệ.' });
    }

    let baseUrl = '';
    let model = '';
    try {
      if (provider.custom) {
        baseUrl = await normalizeCustomBaseUrl(req.body?.baseUrl ?? existing?.baseUrl);
        model = sanitizeModelId(req.body?.model ?? existing?.model);
        if (!model) throw new Error('Nhập tên model (ví dụ: llama-3.3-70b).');
      }
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    const apiKey = apiKeyInput || openSecret(existing.secret);
    const check = await verifyProviderKey(provider, apiKey, baseUrl);
    if (!check.ok) {
      return res.status(400).json({ success: false, code: 'KEY_VERIFY_FAILED', message: check.message });
    }

    const doc =
      existing ||
      new ProviderApiKey({ user: new mongoose.Types.ObjectId(req.buyerId), provider: provider.id });
    doc.secret = sealSecret(apiKey);
    doc.last4 = apiKey.slice(-4);
    doc.baseUrl = baseUrl;
    doc.model = model;
    doc.status = 'active';
    doc.lastVerifiedAt = new Date();
    await doc.save();
    res.json({ success: true, key: doc.toPublic() });
  } catch (err) {
    next(err);
  }
});

router.post('/keys/:provider/test', authenticateBuyer, async (req, res, next) => {
  try {
    const provider = requireProvider(req, res);
    if (!provider) return;
    const doc = await ProviderApiKey.findOne({ user: req.buyerId, provider: provider.id }).select('+secret');
    if (!doc) return res.status(404).json({ success: false, message: 'Chưa lưu key cho provider này.' });
    const check = await verifyProviderKey(provider, openSecret(doc.secret), doc.baseUrl);
    doc.status = check.ok ? 'active' : 'invalid';
    if (check.ok) doc.lastVerifiedAt = new Date();
    await doc.save();
    res.status(check.ok ? 200 : 400).json({ success: check.ok, message: check.message, key: doc.toPublic() });
  } catch (err) {
    next(err);
  }
});

router.delete('/keys/:provider', authenticateBuyer, async (req, res, next) => {
  try {
    const provider = requireProvider(req, res);
    if (!provider) return;
    await ProviderApiKey.deleteOne({ user: req.buyerId, provider: provider.id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Gateway-only: decrypted keys for one buyer. Returns every active provider so the
 * plugin can cache one response per user.
 */
router.get('/resolve', async (req, res, next) => {
  try {
    if (!serviceSecretOk(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const userId = String(req.query.user_id || req.query.userId || '').trim().toLowerCase();
    if (!USER_ID_RE.test(userId)) {
      return res.status(400).json({ success: false, message: 'user_id required' });
    }
    const rows = await ProviderApiKey.find({ user: userId, status: 'active' }).select('+secret');
    const keys = {};
    const stale = [];
    for (const row of rows) {
      try {
        keys[row.provider] = {
          apiKey: openSecret(row.secret),
          ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
          ...(row.model ? { model: row.model } : {}),
        };
      } catch {
        console.warn(`[openclaw-byok] cannot decrypt key user=${userId} provider=${row.provider}`);
        continue;
      }
      if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
        stale.push(row._id);
      }
    }
    if (stale.length) {
      ProviderApiKey.updateMany({ _id: { $in: stale } }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, userId, keys });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
