const config = require('../config/env');
const { escapeHtml } = require('../utils/checkout-email');

const COMPANY = {
  vi: 'Công ty TNHH Giải pháp Công nghệ PHGroup',
  en: 'PHGroup Technology Solutions Co., Ltd.',
};

function lang(l) {
  return l === 'vi' ? 'vi' : 'en';
}

/** Pick vi/en; zh users get English (fallback). */
function pick(l, vi, en) {
  return lang(l) === 'vi' ? vi : en;
}

function siteUrl(path = '') {
  const base = String(config.frontendUrl || 'https://aimarkets.vn').replace(/\/+$/, '');
  if (!path) return base;
  if (/^https?:\/\//.test(path)) return path;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Shared branded layout. `lines` are plain strings (escaped here).
 * Returns { subject, html, text }.
 */
function layout({ l = 'vi', subject, heading, greeting, lines = [], cta, note, unsubscribeUrl }) {
  const L = lang(l);
  const company = COMPANY[L];
  const footerLegal = pick(
    L,
    'Email tự động từ AI Markets (aimarkets.vn). Vui lòng không trả lời trực tiếp nếu không cần hỗ trợ.',
    'Automated email from AI Markets (aimarkets.vn). Reply only if you need support.',
  );
  const unsubText = pick(L, 'Tắt loại email này', 'Turn off this type of email');
  const htmlLines = lines.map((x) => `<p style="margin:0 0 12px;line-height:1.6">${escapeHtml(x)}</p>`).join('');
  const button = cta
    ? `<p style="margin:20px 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(cta.label)}</a></p>`
    : '';
  const noteHtml = note ? `<p style="margin:16px 0 0;color:#6b7280;font-size:13px;line-height:1.5">${escapeHtml(note)}</p>` : '';
  const unsub = unsubscribeUrl
    ? `<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#9ca3af">${escapeHtml(unsubText)}</a>`
    : '';
  const html = `<!doctype html><html lang="${L}"><body style="margin:0;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e7e5e4">
<tr><td style="background:#0b0b0b;padding:18px 24px;color:#d4b26a;font-size:18px;font-weight:700;letter-spacing:.3px">AI Markets</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(heading || subject)}</h1>
${greeting ? `<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>` : ''}
${htmlLines}${button}${noteHtml}
</td></tr>
<tr><td style="padding:16px 24px;background:#fafaf9;color:#9ca3af;font-size:12px;line-height:1.5">
${escapeHtml(company)} · <a href="${escapeHtml(siteUrl())}" style="color:#9ca3af">aimarkets.vn</a><br>${escapeHtml(footerLegal)}${unsub}
</td></tr></table></td></tr></table></body></html>`;
  const text = [
    heading || subject,
    '',
    greeting || '',
    ...lines,
    cta ? `${cta.label}: ${cta.url}` : '',
    note || '',
    '',
    `— AI Markets · ${company}`,
    unsubscribeUrl ? `${unsubText}: ${unsubscribeUrl}` : '',
  ]
    .filter((x, i, a) => x !== '' || a[i - 1] !== '')
    .join('\n')
    .trim();
  return { subject: `AI Markets — ${subject}`, html, text };
}

function fmtWhen(d, l) {
  const date = d ? new Date(d) : new Date();
  return `${date.toLocaleString(lang(l) === 'vi' ? 'vi-VN' : 'en-GB', { timeZone: 'Asia/Ho_Chi_Minh' })} (GMT+7)`;
}

function hi(l, name) {
  return pick(l, `Xin chào ${name || 'bạn'},`, `Hi ${name || 'there'},`);
}

const TEMPLATES = {
  welcome: ({ l, name }) =>
    layout({
      l,
      subject: pick(l, 'Chào mừng bạn đến với AI Markets', 'Welcome to AI Markets'),
      greeting: hi(l, name),
      lines: [
        pick(l, 'Tài khoản AI Markets của bạn đã được tạo thành công.', 'Your AI Markets account has been created.'),
        pick(
          l,
          'Bạn có thể nạp ví bằng chuyển khoản VietQR, thuê agent, mua model/API và quản lý mọi thứ trong bảng điều khiển.',
          'You can top up your wallet via VietQR bank transfer, rent agents, buy models/APIs and manage everything in your dashboard.',
        ),
      ],
      cta: { label: pick(l, 'Mở bảng điều khiển', 'Open dashboard'), url: siteUrl('/dashboard') },
      note: pick(
        l,
        'Nếu bạn không tạo tài khoản này, hãy liên hệ support@aimarkets.vn.',
        'If you did not create this account, contact support@aimarkets.vn.',
      ),
    }),
  loginNotice: ({ l, name, when, ip, device, unsubscribeUrl }) =>
    layout({
      l,
      subject: pick(l, 'Đăng nhập mới vào tài khoản', 'New sign-in to your account'),
      greeting: hi(l, name),
      lines: [
        pick(l, 'Tài khoản của bạn vừa được đăng nhập.', 'Your account was just signed in.'),
        `${pick(l, 'Thời gian', 'Time')}: ${fmtWhen(when, l)}`,
        ip ? `IP: ${ip}` : '',
        device ? `${pick(l, 'Thiết bị', 'Device')}: ${String(device).slice(0, 160)}` : '',
        pick(
          l,
          'Nếu không phải bạn, hãy đổi mật khẩu ngay và đăng xuất mọi thiết bị.',
          'If this was not you, change your password now and sign out of all devices.',
        ),
      ].filter(Boolean),
      cta: { label: pick(l, 'Kiểm tra bảo mật tài khoản', 'Review account security'), url: siteUrl('/settings') },
      unsubscribeUrl,
    }),
  passwordReset: ({ l, name, resetUrl, minutes = 30 }) =>
    layout({
      l,
      subject: pick(l, 'Đặt lại mật khẩu', 'Reset your password'),
      greeting: hi(l, name),
      lines: [
        pick(l, 'Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn.', 'We received a request to reset your password.'),
        pick(l, `Liên kết có hiệu lực trong ${minutes} phút và chỉ dùng được một lần.`, `The link is valid for ${minutes} minutes and can be used once.`),
      ],
      cta: { label: pick(l, 'Đặt lại mật khẩu', 'Reset password'), url: resetUrl },
      note: pick(l, 'Nếu bạn không yêu cầu, hãy bỏ qua email này. Mật khẩu sẽ không thay đổi.', 'If you did not request this, ignore this email. Your password will not change.'),
    }),
  passwordChanged: ({ l, name, when }) =>
    layout({
      l,
      subject: pick(l, 'Mật khẩu đã được thay đổi', 'Your password was changed'),
      greeting: hi(l, name),
      lines: [
        pick(l, `Mật khẩu tài khoản của bạn đã được thay đổi lúc ${fmtWhen(when, l)}.`, `Your account password was changed at ${fmtWhen(when, l)}.`),
        pick(l, 'Các phiên đăng nhập khác đã bị đăng xuất.', 'Other sessions have been signed out.'),
        pick(l, 'Nếu không phải bạn, hãy dùng "Quên mật khẩu" ngay và liên hệ support@aimarkets.vn.', 'If this was not you, use "Forgot password" now and contact support@aimarkets.vn.'),
      ],
      cta: { label: pick(l, 'Đăng nhập', 'Sign in'), url: siteUrl('/login') },
    }),
  /** Generic: an in-app notification mirrored to email (complaints, refunds…). */
  notification: ({ l, name, title, body, href }) =>
    layout({
      l,
      subject: title,
      greeting: hi(l, name),
      lines: [body],
      cta: href ? { label: pick(l, 'Xem chi tiết', 'View details'), url: siteUrl(href) } : null,
    }),
};

function renderEmail(kind, data = {}) {
  const t = TEMPLATES[kind];
  if (!t) throw new Error(`Unknown email template: ${kind}`);
  return t({ ...data, l: lang(data.l || data.lang) });
}

module.exports = { renderEmail, layout, siteUrl, TEMPLATES };
