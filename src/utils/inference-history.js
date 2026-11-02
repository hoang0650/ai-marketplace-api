const mongoose = require('mongoose');
const Request = require('../models/InferenceRequest');
const Product = require('../models/Product');
const { productSlugQuery } = require('./product-slug');
const SECRET = /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|headers)$/i;
function snapshot(value) {
  let budget = 120000;
  function walk(v, depth = 0, key = '') {
    budget -= 16;
    if (SECRET.test(key)) return '[redacted]';
    if (/base64/i.test(key) || (typeof v === 'string' && v.startsWith('data:'))) return '[binary omitted]';
    if (depth > 8 || budget <= 0) return '[truncated]';
    if (typeof v === 'string') { const s = v.slice(0, Math.min(32000, budget)); budget -= s.length; return s.length < v.length ? s + '… [truncated]' : s; }
    if (Array.isArray(v)) return v.slice(0, 100).map(x => walk(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 100).map(([k,x]) => [k, walk(x, depth + 1, k)]));
    return v;
  }
  return walk(value);
}
function ownerFilter(user, extra = {}) { return { ...extra, owner: user._id }; }
async function recordRequest(req, res, next) {
  try {
    const slug = String(req.body?.productSlug || req.body?.model || req.params.id || '').slice(0, 200);
    const pid = req.body?.productId;
    const product = pid && mongoose.isValidObjectId(pid) ? await Product.findById(pid).select('_id slug').lean() : slug ? await Product.findOne(productSlugQuery(slug)).select('_id slug').lean() : null;
    const started = Date.now();
    const row = await Request.create({ owner: req.user._id, product: product?._id || null, productSlug: product?.slug || slug, model: req.body?.input?.model || slug, request: snapshot(req.body?.input || req.body) });
    const send = res.json.bind(res); let captured = false;
    res.json = function(body) {
      if (captured) return send(body); captured = true;
      const result = body && typeof body === 'object' && !Array.isArray(body) ? { ...body, requestLogId: String(row._id) } : body;
      const usage = body?.output?.usage || body?.usage || body?.ai?.usage || {};
      const update = { status: res.statusCode >= 400 || body?.ok === false ? 'FAILED' : 'COMPLETED', response: snapshot(result), executionMs: Number(body?.executionTime) || Date.now() - started, delayMs: Number(body?.delayTime) || 0, cost: Number(body?.cost ?? body?.marketplace?.cost ?? body?.charged) || 0, usage: snapshot(usage) };
      return Request.updateOne({ _id: row._id, owner: req.user._id }, { $set: update }).catch(() => undefined).then(() => { if (!res.destroyed) return send(result); }).catch(next);
    };
    res.once('close', () => { if (!captured) Request.updateOne({ _id: row._id, status: 'RUNNING' }, { $set: { status: 'FAILED', executionMs: Date.now() - started, response: { error: 'Connection closed before completion' } } }).catch(() => {}); });
    next();
  } catch(e) { next(e); }
}
function view(row, detail = false) {
  const r = { id: String(row._id), productId: String(row.product || ''), productSlug: row.productSlug, model: row.model, status: row.status, executionMs: row.executionMs, delayMs: row.delayMs, createdAt: row.createdAt, cost: row.cost, usage: row.usage };
  if (detail) { r.requestJson = JSON.stringify(row.request, null, 2); r.responseJson = JSON.stringify(row.response || {}, null, 2); }
  return r;
}
module.exports = { recordRequest, snapshot, ownerFilter, view };
