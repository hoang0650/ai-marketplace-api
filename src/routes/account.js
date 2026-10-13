const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const AccountDeletionRequest = require('../models/AccountDeletionRequest');
const { authenticate, clearRefreshCookie } = require('../middleware/auth');
const { deletionPreview, deleteAccount } = require('../services/account-deletion-service');
const { isConfirmWord, deletionNotice, PUBLIC_REQUEST_SLA_DAYS } = require('../utils/account-deletion');
const { sendResendEmail } = require('../utils/mailer');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What will be deleted/retained and whether anything blocks deletion right now. */
router.get('/deletion', authenticate, async (req, res, next) => {
  try {
    const preview = await deletionPreview(req.user._id);
    const user = await User.findById(req.user._id).select('passwordHash authProvider').lean();
    res.json({ ...deletionNotice(), ...preview, requiresPassword: Boolean(user?.passwordHash) });
  } catch (err) {
    next(err);
  }
});

/**
 * Delete the signed-in account now. Body: { confirm: "XÓA" | "DELETE", password? (local accounts), reason?, source? }.
 * 409 ACCOUNT_DELETION_BLOCKED lists what must be settled first (wallet balance, open orders, …).
 */
router.post('/deletion', authenticate, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!isConfirmWord(body.confirm)) {
      return res.status(400).json({ code: 'CONFIRM_REQUIRED', message: 'Nhập "XÓA" để xác nhận xóa tài khoản.' });
    }
    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (user.passwordHash) {
      const ok = await bcrypt.compare(String(body.password || ''), user.passwordHash);
      if (!ok) return res.status(401).json({ code: 'INVALID_PASSWORD', message: 'Mật khẩu không đúng.' });
    }
    if (user.role === 'admin') {
      return res.status(403).json({ code: 'ADMIN_CANNOT_SELF_DELETE', message: 'Tài khoản quản trị không thể tự xóa.' });
    }
    const preview = await deletionPreview(user._id);
    if (!preview.canDelete) {
      return res.status(409).json({
        code: 'ACCOUNT_DELETION_BLOCKED',
        message: 'Chưa thể xóa tài khoản.',
        blockers: preview.blockers,
      });
    }
    const source = body.source === 'web' ? 'web' : 'app';
    const result = await deleteAccount(user, {
      source,
      reason: body.reason,
      ip: req.ip,
      userAgent: String(req.get('user-agent') || '').slice(0, 300),
    });
    clearRefreshCookie(res);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * Public deletion request (Google Play web link) for people who cannot sign in.
 * Always answers 202 so the form cannot be used to discover registered emails.
 */
router.post('/deletion-requests', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ code: 'EMAIL_INVALID', message: 'Email không hợp lệ.' });
    const reason = String(req.body?.reason || '').slice(0, 1000);
    const exists = await User.exists({ email, accountStatus: { $ne: 'deleted' } });
    const now = new Date();
    if (exists) {
      const dueAt = new Date(now.getTime() + PUBLIC_REQUEST_SLA_DAYS * 24 * 60 * 60 * 1000);
      const open = await AccountDeletionRequest.findOne({ email, status: 'pending', source: 'public_web' });
      if (!open) {
        await AccountDeletionRequest.create({ user: exists._id, email, source: 'public_web', reason, dueAt, ip: req.ip });
        sendResendEmail({
          to: email,
          subject: 'AI Markets – Yêu cầu xóa tài khoản',
          text:
            `Chúng tôi đã nhận yêu cầu xóa tài khoản ${email}. Bạn có thể xóa ngay tại Cài đặt > Xóa tài khoản sau khi đăng nhập ` +
            `(website hoặc ứng dụng). Nếu không thể đăng nhập, bộ phận hỗ trợ sẽ xác minh danh tính và xử lý trong ${PUBLIC_REQUEST_SLA_DAYS} ngày. ` +
            'Nếu bạn không gửi yêu cầu này, hãy bỏ qua email. Hỗ trợ: support@aimarkets.vn, 0931 881 584.',
        }).catch(() => {});
      }
    }
    res.status(202).json({ ok: true, slaDays: PUBLIC_REQUEST_SLA_DAYS });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
