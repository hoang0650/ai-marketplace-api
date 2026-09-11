function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(amount, currency = 'USD') {
  const n = Number(amount) || 0;
  const cur = String(currency || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat(cur === 'VND' ? 'vi-VN' : 'en-US', {
      style: 'currency',
      currency: cur,
      maximumFractionDigits: cur === 'VND' ? 0 : 2,
    }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
}

function formatTerm(term) {
  if (term === 'day') return '1 ngày';
  if (term === 'year') return '1 năm';
  if (term === 'month') return '1 tháng';
  return term || '';
}

function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

/**
 * Pure template — used by Resend send and unit tests.
 * `license` is the mapped license object or null.
 */
function buildCheckoutEmail({
  buyerName,
  productName,
  orderId,
  amount,
  currency,
  quantity = 1,
  license = null,
  licensesUrl = 'https://aimarkets.vn/dashboard/licenses',
} = {}) {
  const name = buyerName || 'bạn';
  const product = productName || 'Sản phẩm AI Markets';
  const money = formatMoney(amount, currency);
  const hasLicense = !!(license && license.licenseKey);
  const subject = hasLicense
    ? `AI Markets — Thanh toán thành công · License ${license.licenseKey}`
    : `AI Markets — Thanh toán thành công · ${product}`;

  const licenseText = hasLicense
    ? [
        '',
        'LICENSE KEY (dùng để xem / đọc / tải trong thời hạn đã mua):',
        license.licenseKey,
        `Thời hạn: ${formatTerm(license.term)}`,
        license.expiresAt ? `Hết hạn: ${formatWhen(license.expiresAt)}` : '',
        `Quản lý key: ${licensesUrl}`,
        'Không chia sẻ key. Key chỉ mở đúng sản phẩm đã mua — không dùng cho listing khác cùng shop. Hết hạn hoặc hoàn tiền thì key vô hiệu.',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const text = [
    `Xin chào ${name},`,
    '',
    'Thanh toán trên AI Markets đã thành công.',
    `Đơn hàng: ${orderId}`,
    `Sản phẩm: ${product}`,
    `Số lượng: ${quantity}`,
    `Số tiền: ${money}`,
    licenseText,
    '',
    'Cảm ơn bạn đã mua trên aimarkets.vn',
    'Hỗ trợ: support@aimarkets.vn',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const licenseHtml = hasLicense
    ? `
      <tr>
        <td style="padding:20px 0 8px;font-size:13px;color:#555;text-transform:uppercase;letter-spacing:.06em">License key</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;background:#111;color:#f5f0e6;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;letter-spacing:.08em;border-radius:8px">
          ${escapeHtml(license.licenseKey)}
        </td>
      </tr>
      <tr>
        <td style="padding:12px 0 0;font-size:14px;color:#333">
          Thời hạn <strong>${escapeHtml(formatTerm(license.term))}</strong>
          ${license.expiresAt ? ` · hết hạn <strong>${escapeHtml(formatWhen(license.expiresAt))}</strong>` : ''}
        </td>
      </tr>
      <tr>
        <td style="padding:8px 0 0;font-size:13px;color:#666">
          Key chỉ mở đúng sản phẩm đã mua (không dùng chung cho listing khác cùng shop). Chỉ xem / đọc / tải trong thời hạn. Không chia sẻ. Hết hạn hoặc hoàn tiền thì key vô hiệu.
          <br /><a href="${escapeHtml(licensesUrl)}" style="color:#8b5a2b">Xem license trong dashboard</a>
        </td>
      </tr>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="vi">
<body style="margin:0;background:#f4f1ea;font-family:Georgia,Times,serif;color:#1a1a1a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;padding:24px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;padding:32px 28px;border-radius:12px">
          <tr><td style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#8b5a2b">AI Markets</td></tr>
          <tr><td style="padding:12px 0 0;font-size:24px">Thanh toán thành công</td></tr>
          <tr><td style="padding:8px 0 20px;font-size:15px;color:#444">Xin chào ${escapeHtml(name)}, đơn hàng của bạn đã được ghi nhận.</td></tr>
          <tr><td>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#333">
              <tr><td style="padding:6px 0;color:#666">Đơn hàng</td><td align="right">${escapeHtml(orderId)}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Sản phẩm</td><td align="right">${escapeHtml(product)}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Số lượng</td><td align="right">${escapeHtml(quantity)}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Số tiền</td><td align="right"><strong>${escapeHtml(money)}</strong></td></tr>
            </table>
          </td></tr>
          ${licenseHtml}
          <tr><td style="padding:28px 0 0;font-size:13px;color:#888">aimarkets.vn · support@aimarkets.vn</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text, hasLicense };
}

module.exports = { buildCheckoutEmail, escapeHtml, formatMoney, formatTerm };
