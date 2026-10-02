const Notification = require('../models/Notification');

/**
 * Vietnamese copy stored in title/body as a fallback for clients that do not
 * translate by `key`. Web and app render `notify.<key>.title|body` with `params`
 * in the user's language; keep placeholders in sync with their dictionaries.
 * `params.note` (optional) is appended to the body by every client.
 */
const COPY = {
  'wallet.depositCompleted': ['Nạp tiền đã xác nhận', 'Số tiền đã được cộng vào ví.'],
  'wallet.depositRejected': ['Yêu cầu nạp bị từ chối', 'Admin đã từ chối hoặc hủy yêu cầu nạp tiền.'],
  'wallet.withdrawCompleted': ['Rút tiền đã chuyển', 'Yêu cầu rút đã được thanh toán.'],
  'wallet.withdrawRejected': ['Yêu cầu rút bị từ chối', 'Số tiền đã được hoàn lại số dư khả dụng.'],
  'kyc.verified': ['eKYC đã được duyệt', 'Hồ sơ xác minh của bạn đã được duyệt. Bạn có thể rút tiền.'],
  'kyc.rejected': ['eKYC bị từ chối', 'Hồ sơ xác minh bị từ chối: {reason} Vui lòng cập nhật và gửi lại.'],
  'chat.newMessage': ['Tin nhắn mới', '{sender}: {preview}'],
  'order.new': ['Đơn hàng mới', '{buyer} đã mua {product} ({ownership})'],
  'order.paid': ['Thanh toán thành công', '{product} đã thanh toán bằng ví AI Markets.'],
  'order.paidLicense': ['Thanh toán thành công', '{product} · license {licenseKey}. Email xác nhận đã gửi.'],
  'dispute.opened': ['Khiếu nại đơn hàng', '{actor} đã khiếu nại {product}. Khoản thu của seller bị tạm giữ cho đến khi giải quyết.'],
  'dispute.closedSeller': ['Khiếu nại đã đóng', 'Khiếu nại về {product} đã được giải quyết có lợi cho seller. Khoản thanh toán đã có thể rút.'],
  'dispute.closedBuyer': ['Khiếu nại đã đóng', 'Khiếu nại về {product} đã được giải quyết có lợi cho seller.'],
  'dispute.refundBuyer': ['Hoàn tiền khiếu nại', 'Đã hoàn {amount} {currency} cho {product}.'],
  'dispute.refundSeller': ['Khiếu nại: hoàn tiền người mua', 'Khoản phải trả seller {amount} {currency} cho {product} đã bị đảo ngược (hoa hồng/thuế đã điều chỉnh trên sổ cái).'],
  'complaint.workNew': ['Khiếu nại Work mới', '{job}: {text}'],
  'complaint.workAdmin': ['Khiếu nại Work', '{kind} · {job}'],
  'complaint.new': ['Khiếu nại mới', '{text}'],
  'complaint.newAdmin': ['Khiếu nại mới', '{kind}'],
  'complaint.sellerReplied': ['{caseRef}: seller đã phản hồi', 'Seller đã gửi phản hồi. Sàn đang xem xét bằng chứng.'],
  'complaint.sellerRepliedAdmin': ['{caseRef}: seller đã phản hồi', 'Đã nhận phản hồi của seller. Hồ sơ chuyển sang xem xét bằng chứng.'],
  'complaint.appeal': ['{caseRef}: kháng nghị', '{name} yêu cầu xem xét lại nội bộ.'],
  'complaint.askSeller': ['{caseRef}: yêu cầu seller phản hồi', 'Sàn yêu cầu bạn phản hồi khiếu nại này.'],
  'complaint.decision': ['{caseRef}: quyết định', 'Quyết định: {decision}. {detail}'],
  'gpu.lowBalance': ['Số dư sắp hết', 'GPU "{name}" còn khoảng {minutes} phút theo số dư hiện tại. Nạp thêm để tránh bị dừng.'],
  'gpu.stoppedNoFunds': ['GPU đã tạm dừng', 'GPU "{name}" đã dừng do hết số dư. Dữ liệu được giữ {hours} giờ; nạp tiền để tiếp tục.'],
  'gpu.terminatedNoFunds': ['GPU đã bị xóa', 'GPU "{name}" và dữ liệu đã bị xóa do không nạp tiền trong thời hạn.'],
  'stream.lowBalance': ['Số dư sắp hết', 'Phiên stream "{name}" còn khoảng {minutes} phút theo số dư hiện tại. Nạp thêm để tránh bị ngắt.'],
  'stream.stoppedNoFunds': ['Phiên stream đã dừng', 'Phiên stream "{name}" đã dừng do hết số dư. Nạp tiền để chơi tiếp.'],
  'training.succeeded': ['Train model hoàn tất', 'Job "{name}" đã train xong. Tải model tại trang Train model.'],
  'training.failed': ['Train model thất bại', 'Job "{name}" bị lỗi. Xem log để biết chi tiết.'],
};

function fill(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (params[k] == null ? '' : String(params[k])));
}

function cleanParams(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    out[k] = typeof v === 'number' ? v : String(v).slice(0, 400);
  }
  return out;
}

function buildNotification(key, params = {}) {
  const copy = COPY[key];
  if (!copy) throw new Error(`Unknown notification key: ${key}`);
  const p = cleanParams(params);
  const body = fill(copy[1], p).trim();
  return {
    key,
    params: p,
    title: fill(copy[0], p).slice(0, 200),
    body: (p.note ? `${body} ${p.note}` : body).slice(0, 400),
  };
}

async function notifyUser(user, key, params, href) {
  if (!user) return null;
  return Notification.create({ user, href, ...buildNotification(key, params) });
}

async function notifyMany(userIds, key, params, href) {
  const ids = [...new Set((userIds || []).filter(Boolean).map((id) => String(id)))];
  if (!ids.length) return;
  const doc = buildNotification(key, params);
  await Notification.insertMany(ids.map((user) => ({ user, href, ...doc })));
}

const LEGACY_FIXED = {
  'Nạp tiền đã xác nhận': 'wallet.depositCompleted',
  'Yêu cầu nạp bị từ chối': 'wallet.depositRejected',
  'Rút tiền đã chuyển': 'wallet.withdrawCompleted',
  'Yêu cầu rút bị từ chối': 'wallet.withdrawRejected',
  'eKYC đã được duyệt': 'kyc.verified',
};

/** Best-effort key for notifications stored before `key` existed. */
function inferLegacy(title, body) {
  const t = String(title || '');
  const b = String(body || '');
  const fixed = LEGACY_FIXED[t];
  if (fixed) {
    const base = COPY[fixed][1];
    const note = b.startsWith(base) ? b.slice(base.length).trim() : '';
    if (!b.startsWith(base) && b) return null;
    return { key: fixed, params: note ? { note } : {} };
  }
  if (t === 'eKYC bị từ chối') {
    const m = b.match(/^Hồ sơ xác minh bị từ chối: ([\s\S]*) Vui lòng cập nhật và gửi lại\.$/);
    return m ? { key: 'kyc.rejected', params: { reason: m[1] } } : null;
  }
  if (t === 'Tin nhắn mới') {
    const i = b.indexOf(': ');
    return i > 0 ? { key: 'chat.newMessage', params: { sender: b.slice(0, i), preview: b.slice(i + 2) } } : null;
  }
  if (t === 'Thanh toán thành công') {
    let m = b.match(/^([\s\S]*) · license (\S+)\. Email xác nhận đã gửi\.$/);
    if (m) return { key: 'order.paidLicense', params: { product: m[1], licenseKey: m[2] } };
    m = b.match(/^([\s\S]*) đã thanh toán bằng ví AI Markets\.$/);
    return m ? { key: 'order.paid', params: { product: m[1] } } : null;
  }
  if (t === 'New order') {
    const m = b.match(/^([\s\S]*) purchased ([\s\S]*) \(([^()]*)\)$/);
    return m ? { key: 'order.new', params: { buyer: m[1], product: m[2], ownership: m[3] } } : null;
  }
  return null;
}

module.exports = { buildNotification, notifyUser, notifyMany, inferLegacy, NOTIFY_COPY: COPY };
