/**
 * Cross-device handoff ("Tiếp tục trên điện thoại") + connected devices + sync feed.
 *
 *   POST   /v1/handoff                 create a 2-minute single-use code for one of MY sessions
 *   POST   /v1/handoff/claim           phone (logged in as the SAME user) redeems the code
 *   DELETE /v1/handoff/:code           cancel a code early
 *   GET    /v1/handoff/devices         my devices
 *   POST   /v1/handoff/devices         register / heartbeat this device (X-Device-Id)
 *   DELETE /v1/handoff/devices/:id     revoke a device
 *   GET    /v1/handoff/sync            long-poll my event feed (?since=<cursor>&wait=<s>)
 *
 * Isolation: every query is scoped to req.user; a code only ever points at a session the
 * creator owns, and only that same user can redeem it. Codes never mint tokens.
 */
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const config = require('../config/env');
const { authenticate } = require('../middleware/auth');
const DeviceLink = require('../models/DeviceLink');
const HandoffCode = require('../models/HandoffCode');
const BuilderProject = require('../models/BuilderProject');
const HiredAgent = require('../models/HiredAgent');
const AgentSubscription = require('../models/AgentSubscription');
const bus = require('../realtime/user-bus');
const notify = require('../utils/notify');

const router = express.Router();

const CODE_TTL_MS = 2 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const MAX_OPEN_CODES = 5;
const CLAIM_LIMIT = 10;
const CLAIM_WINDOW_MS = 5 * 60 * 1000;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_WAIT_S = 25;

const err = (res, status, code, message) => res.status(status).json({ error: { code, message } });

function newCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/** "abcd-2345" / " ABCD2345 " / a scanned https/aimarkets:// URL -> "ABCD2345" */
function normalizeCode(input) {
  let s = String(input || '').trim();
  const m = s.match(/handoff\/([A-Za-z0-9-]{8,12})/);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === CODE_LEN && [...s].every((c) => ALPHABET.includes(c)) ? s : '';
}

const hashCode = (code) => crypto.createHash('sha256').update(`handoff:${code}`).digest('hex');
const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const frontend = () => String(config.frontendUrl).replace(/\/+$/, '');

function headerName(raw) {
  let v = String(raw || '');
  try {
    v = decodeURIComponent(v);
  } catch {
    /* keep raw */
  }
  return v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
}

function deviceInfo(req) {
  const id = String(req.get('x-device-id') || req.body?.deviceId || '').trim();
  const platform = String(req.get('x-device-platform') || req.body?.platform || '').toLowerCase();
  return {
    deviceId: DEVICE_ID_RE.test(id) ? id : '',
    platform: ['web', 'ios', 'android'].includes(platform) ? platform : 'other',
    name: headerName(req.body?.deviceName || req.get('x-device-name') || ''),
  };
}

/** Upserts this device; returns null when it was revoked (caller must refuse). */
async function touchDevice(req, { linkedVia } = {}) {
  const d = deviceInfo(req);
  if (!d.deviceId) return { device: null, revoked: false };
  const existing = await DeviceLink.findOne({ user: req.user._id, deviceId: d.deviceId }).lean();
  if (existing?.revokedAt) return { device: existing, revoked: true };
  const set = { lastActiveAt: new Date(), lastIp: String(req.ip || '').slice(0, 64), platform: d.platform };
  if (d.name) set.name = d.name;
  if (linkedVia) set.linkedVia = linkedVia;
  const device = await DeviceLink.findOneAndUpdate(
    { user: req.user._id, deviceId: d.deviceId },
    { $set: set, $setOnInsert: { user: req.user._id, deviceId: d.deviceId } },
    { upsert: true, new: true }
  ).lean();
  return { device, revoked: false, created: !existing };
}

/** Resolves a target the caller owns, or null. Never looks at other users' data. */
async function ownedTarget(userId, kind, id) {
  if (kind === 'builder') {
    if (!mongoose.isValidObjectId(id)) return null;
    const p = await BuilderProject.findOne({ _id: id, owner: userId }).select('name kind').lean();
    return p ? { kind, id: String(p._id), title: p.name || '', path: `/build/${p._id}` } : null;
  }
  if (kind === 'agent') {
    if (!AGENT_ID_RE.test(String(id || ''))) return null;
    const [hired, sub] = await Promise.all([
      HiredAgent.findOne({ user: userId, agentId: id }).select('agentId name').lean(),
      AgentSubscription.findOne({ user: userId, agentId: id }).select('agentId brand').lean(),
    ]);
    if (!hired && !sub) return null;
    return { kind, id, title: hired?.name || sub?.brand || id, path: `/hire-agent/${id}` };
  }
  return null;
}

// In-memory claim throttle per user and per IP (codes are 40-bit, this just stops hammering).
const attempts = new Map();
function throttled(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < CLAIM_WINDOW_MS);
  attempts.set(key, list);
  return list.length >= CLAIM_LIMIT;
}
function recordAttempt(key) {
  attempts.get(key)?.push(Date.now()) ?? attempts.set(key, [Date.now()]);
}

function publicDevice(d, currentId) {
  return {
    id: String(d._id),
    name: d.name || '',
    platform: d.platform,
    linkedVia: d.linkedVia,
    lastActiveAt: d.lastActiveAt,
    createdAt: d.createdAt,
    revoked: !!d.revokedAt,
    current: !!currentId && d.deviceId === currentId,
  };
}

router.use(authenticate);

router.post('/', async (req, res, next) => {
  try {
    const { revoked } = await touchDevice(req);
    if (revoked) return err(res, 403, 'DEVICE_REVOKED', 'Thiết bị này đã bị thu hồi.');
    const kind = String(req.body?.kind || '');
    const target = await ownedTarget(req.user._id, kind, String(req.body?.id || ''));
    if (!target) return err(res, 404, 'HANDOFF_TARGET_NOT_FOUND', 'Không tìm thấy phiên làm việc của bạn.');
    const open = await HandoffCode.countDocuments({ user: req.user._id, usedAt: null, cancelledAt: null, expiresAt: { $gt: new Date() } });
    if (open >= MAX_OPEN_CODES) return err(res, 429, 'HANDOFF_TOO_MANY', 'Quá nhiều mã đang mở, thử lại sau 2 phút.');
    const code = newCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await HandoffCode.create({
      codeHash: hashCode(code),
      user: req.user._id,
      fromDevice: deviceInfo(req).deviceId,
      target: { kind: target.kind, id: target.id, title: target.title },
      expiresAt,
    });
    const url = `${frontend()}/handoff/${code}`;
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 });
    res.set('Cache-Control', 'no-store').status(201).json({
      code: formatCode(code),
      expiresAt,
      ttlSeconds: CODE_TTL_MS / 1000,
      url,
      deepLink: `aimarkets://handoff/${code}`,
      qrSvg,
      target,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/claim', async (req, res, next) => {
  try {
    const userKey = `u:${req.user._id}`;
    const ipKey = `ip:${req.ip}`;
    if (throttled(userKey) || throttled(ipKey)) return err(res, 429, 'HANDOFF_RATE_LIMITED', 'Thử quá nhiều lần, đợi vài phút.');
    recordAttempt(userKey);
    recordAttempt(ipKey);
    const code = normalizeCode(req.body?.code);
    if (!code) return err(res, 400, 'HANDOFF_CODE_INVALID', 'Mã không hợp lệ.');
    const { revoked, device } = await touchDevice(req);
    if (revoked) return err(res, 403, 'DEVICE_REVOKED', 'Thiết bị này đã bị thu hồi.');
    const now = new Date();
    const hash = hashCode(code);
    // The code must belong to the caller; another user's code is treated exactly like a bad code.
    const doc = await HandoffCode.findOneAndUpdate(
      { codeHash: hash, user: req.user._id, usedAt: null, cancelledAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now, usedByDevice: device?.deviceId || '' } },
      { new: true }
    ).lean();
    if (!doc) {
      const other = await HandoffCode.findOne({ codeHash: hash }).select('user usedAt expiresAt').lean();
      if (other && String(other.user) !== String(req.user._id)) {
        return err(res, 403, 'HANDOFF_WRONG_USER', 'Mã này thuộc tài khoản khác. Đăng nhập đúng tài khoản trên điện thoại.');
      }
      if (other?.usedAt) return err(res, 410, 'HANDOFF_CODE_USED', 'Mã đã được dùng.');
      if (other) return err(res, 410, 'HANDOFF_CODE_EXPIRED', 'Mã đã hết hạn, tạo mã mới.');
      return err(res, 404, 'HANDOFF_CODE_INVALID', 'Mã không đúng.');
    }
    // Re-check ownership at claim time (the session may have been deleted meanwhile).
    const target = await ownedTarget(req.user._id, doc.target.kind, doc.target.id);
    if (!target) return err(res, 404, 'HANDOFF_TARGET_NOT_FOUND', 'Phiên làm việc không còn tồn tại.');
    if (device) {
      await DeviceLink.updateOne({ _id: device._id }, { $set: { linkedVia: 'handoff' } });
      bus.publish(req.user._id, 'device.linked', { device: publicDevice(device), target }, { fromDevice: device.deviceId });
      notify.notifyUser(req.user._id, 'device.linked', { device: device.name || device.platform, target: target.title || target.kind }, '/account/devices').catch(() => {});
    }
    bus.publish(req.user._id, 'handoff.claimed', { target }, { fromDevice: device?.deviceId });
    res.set('Cache-Control', 'no-store').json({ ok: true, target });
  } catch (e) {
    next(e);
  }
});

router.get('/devices', async (req, res, next) => {
  try {
    await touchDevice(req);
    const list = await DeviceLink.find({ user: req.user._id }).sort({ revokedAt: 1, lastActiveAt: -1 }).limit(50).lean();
    res.set('Cache-Control', 'no-store').json({ devices: list.map((d) => publicDevice(d, deviceInfo(req).deviceId)) });
  } catch (e) {
    next(e);
  }
});

router.post('/devices', async (req, res, next) => {
  try {
    const { device, revoked, created } = await touchDevice(req);
    if (!device) return err(res, 400, 'DEVICE_ID_REQUIRED', 'Thiếu X-Device-Id.');
    if (revoked) return err(res, 403, 'DEVICE_REVOKED', 'Thiết bị này đã bị thu hồi.');
    if (created) bus.publish(req.user._id, 'device.updated', {});
    res.json({ device: publicDevice(device, device.deviceId), cursor: bus.cursorOf(req.user._id) });
  } catch (e) {
    next(e);
  }
});

router.delete('/devices/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return err(res, 404, 'DEVICE_NOT_FOUND', 'Không tìm thấy thiết bị.');
    const d = await DeviceLink.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { revokedAt: new Date() } },
      { new: true }
    ).lean();
    if (!d) return err(res, 404, 'DEVICE_NOT_FOUND', 'Không tìm thấy thiết bị.');
    bus.publish(req.user._id, 'device.revoked', { deviceId: d.deviceId, id: String(d._id) });
    res.json({ ok: true, device: publicDevice(d) });
  } catch (e) {
    next(e);
  }
});

router.delete('/:code', async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (code) await HandoffCode.updateOne({ codeHash: hashCode(code), user: req.user._id, usedAt: null }, { $set: { cancelledAt: new Date() } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.get('/sync', async (req, res, next) => {
  try {
    const { revoked } = await touchDevice(req);
    if (revoked) return err(res, 403, 'DEVICE_REVOKED', 'Thiết bị này đã bị thu hồi.');
    const waitS = Math.max(0, Math.min(MAX_WAIT_S, Number(req.query.wait) || 0));
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    const out = await bus.wait(req.user._id, String(req.query.since || ''), waitS * 1000, ctrl.signal);
    if (res.writableEnded || res.destroyed) return undefined;
    const me = deviceInfo(req).deviceId;
    // A revoked device learns it on its next poll; never echo other devices' raw ids.
    res.set('Cache-Control', 'no-store').json({
      cursor: out.cursor,
      reset: out.reset,
      events: out.events.map((e) => ({ seq: e.seq, type: e.type, data: e.data, at: e.at, self: !!me && e.fromDevice === me })),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports._test = { normalizeCode, newCode, hashCode, ownedTarget, attempts };
