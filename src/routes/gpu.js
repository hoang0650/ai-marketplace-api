const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { authenticate } = require('../middleware/auth');
const { getAvailableBalance } = require('../utils/wallet');
const { gpuRentalConfig } = require('../utils/gpu-rental/config');
const svc = require('../utils/gpu-rental/service');
const gpuProxy = require('../terminal/gpu-proxy');

const router = express.Router();

const TICKET_TTL_S = 120;

const MESSAGES = {
  GPU_UNAVAILABLE: 'Loại GPU này tạm hết, vui lòng chọn loại khác hoặc thử lại sau.',
  PROVIDER_BILLING: 'Hạ tầng GPU tạm thời không khả dụng. Vui lòng thử lại sau.',
  PROVIDER_AUTH: 'Hạ tầng GPU tạm thời không khả dụng. Vui lòng thử lại sau.',
  PROVIDER_ERROR: 'Không thể xử lý yêu cầu GPU lúc này. Vui lòng thử lại sau.',
  PROVIDER_UNAVAILABLE: 'Dịch vụ GPU tạm thời không khả dụng.',
  SERVER_NOT_FOUND: 'Không tìm thấy máy GPU.',
  SERVER_NOT_READY: 'Máy GPU đang khởi động, vui lòng đợi.',
  RENTAL_NOT_FOUND: 'Không tìm thấy máy GPU.',
  RENTAL_TERMINATED: 'Máy GPU đã bị xóa.',
  RENTAL_LIMIT: 'Bạn đã đạt số máy GPU tối đa. Hãy xóa bớt máy cũ.',
  OFFER_NOT_FOUND: 'Loại GPU không hợp lệ.',
  INSUFFICIENT_WALLET: 'Số dư không đủ. Cần tối thiểu 1 giờ sử dụng để khởi động.',
  PAYOUT_HELD: 'Số dư khả dụng không đủ (một phần đang bị tạm giữ).',
};

function sendError(res, next, err) {
  if (!err || !err.status || !err.code) return next(err);
  const status = err.status >= 500 ? 502 : err.status;
  return res.status(status).json({
    message: MESSAGES[err.code] || MESSAGES.PROVIDER_ERROR,
    code: MESSAGES[err.code] ? err.code : 'PROVIDER_ERROR',
    ...(err.status === 402 || err.code === 'RENTAL_LIMIT' ? err.body || {} : {}),
  });
}

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      sendError(res, next, err);
    }
  };
}

router.use(authenticate);

router.get(
  '/offers',
  wrap(async (req, res) => {
    const cfg = gpuRentalConfig();
    const [offers, wallet] = await Promise.all([svc.publicOffers(), getAvailableBalance(req.user._id)]);
    res.json({
      offers,
      currency: 'USD',
      wallet: { available: wallet.available },
      limits: {
        minPrepayHours: cfg.minPrepayHours,
        maxGpuCount: cfg.maxGpuCount,
        maxActive: cfg.maxActivePerUser,
        volumeGb: { min: cfg.volumeGbMin, max: cfg.volumeGbMax, default: cfg.volumeGbDefault },
        diskGb: cfg.diskGb,
        warnMinutes: cfg.warnMinutes,
        terminateGraceHours: Math.round(cfg.terminateGraceMs / 3_600_000),
      },
    });
  })
);

router.get(
  '/rentals',
  wrap(async (req, res) => {
    const rows = await svc.listForUser(req.user._id);
    res.json({ rentals: rows.map(svc.publicRental) });
  })
);

router.post(
  '/rentals',
  wrap(async (req, res) => {
    const rental = await svc.createRental(req.user, req.body || {});
    res.status(201).json({ rental: svc.publicRental(rental) });
  })
);

router.get(
  '/rentals/:id',
  wrap(async (req, res) => {
    const rental = await svc.findOwned(req.user, req.params.id);
    await svc.refreshRental(rental);
    res.json({ rental: svc.publicRental(rental) });
  })
);

router.post(
  '/rentals/:id/start',
  wrap(async (req, res) => {
    const rental = await svc.findOwned(req.user, req.params.id);
    await svc.startRental(rental);
    res.json({ rental: svc.publicRental(rental) });
  })
);

router.post(
  '/rentals/:id/stop',
  wrap(async (req, res) => {
    const rental = await svc.findOwned(req.user, req.params.id);
    await svc.stopRental(rental, req.user.role === 'admin' && String(rental.owner) !== String(req.user._id) ? 'admin' : 'user');
    res.json({ rental: svc.publicRental(rental) });
  })
);

router.delete(
  '/rentals/:id',
  wrap(async (req, res) => {
    const rental = await svc.findOwned(req.user, req.params.id);
    await svc.terminateRental(rental);
    res.json({ rental: svc.publicRental(rental) });
  })
);

/** Short-lived link into the workspace; the proxy swaps the ticket for a path-scoped cookie. */
router.post(
  '/rentals/:id/open',
  wrap(async (req, res) => {
    const rental = await svc.findOwned(req.user, req.params.id);
    if (rental.status === 'terminated') throw Object.assign(new Error('x'), { status: 409, code: 'RENTAL_TERMINATED' });
    if (rental.status !== 'running') throw Object.assign(new Error('x'), { status: 409, code: 'SERVER_NOT_READY' });
    const ticket = jwt.sign(
      { typ: 'gpu-ticket', rid: String(rental._id), uid: String(req.user._id) },
      config.jwtSecret,
      { expiresIn: TICKET_TTL_S, algorithm: 'HS256' }
    );
    const target = req.body?.target === 'terminal' ? 'lab/terminals/1' : 'lab';
    const path = `${svc.jupyterBasePath(String(rental._id))}${target}?ticket=${encodeURIComponent(ticket)}`;
    res.json({ path, expiresIn: TICKET_TTL_S });
  })
);

/** Real shell on the rented pod for the in-app terminal (xterm). Owner only, running pods only. */
router.post(
  '/rentals/:id/terminal',
  wrap(async (req, res) => {
    const rental = await svc.findOwned(req.user, req.params.id);
    if (rental.status === 'terminated') throw Object.assign(new Error('x'), { status: 409, code: 'RENTAL_TERMINATED' });
    if (rental.status !== 'running') throw Object.assign(new Error('x'), { status: 409, code: 'SERVER_NOT_READY' });
    if (String(rental.owner) !== String(req.user._id)) throw Object.assign(new Error('x'), { status: 404, code: 'RENTAL_NOT_FOUND' });
    try {
      const out = await gpuProxy.openTerminal(String(rental._id), String(req.user._id));
      res.json(out);
    } catch (err) {
      const code = err.code === 'RENTAL_TERMINATED' ? 'RENTAL_TERMINATED' : 'SERVER_NOT_READY';
      throw Object.assign(new Error('x'), { status: code === 'RENTAL_TERMINATED' ? 409 : 503, code });
    }
  })
);

module.exports = router;
module.exports.MESSAGES = MESSAGES;
module.exports.sendError = sendError;
