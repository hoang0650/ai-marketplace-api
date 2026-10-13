/**
 * In-app account deletion (App Store 5.1.1(v), Google Play account-deletion policy).
 *
 * Deletion is immediate once the user confirms and nothing blocks it: the User document is kept
 * as an anonymised tombstone (soft delete) so orders, wallet, ledger, invoices, tax records and
 * complaints that the law requires us to keep (Quy chế Mục XIX, Chính sách lưu trữ Điều 2:
 * 03 năm) still point at a valid id, while every piece of personal profile data is erased.
 * There is no grace period: the codebase has no such convention, so the request is processed at once.
 */

const RETENTION_YEARS = 3;
/** Requests sent from the public web form (no sign-in) are processed within this many days. */
const PUBLIC_REQUEST_SLA_DAYS = 30;
const CONFIRM_WORDS = ['XOA', 'XÓA', 'XOÁ', 'DELETE', '删除'];
const DELETED_NAME = 'Tài khoản đã xóa';
/** Wallet amounts below this (USD) are treated as zero. */
const BALANCE_EPSILON = 0.01;

const BLOCKER_MESSAGES = {
  WALLET_BALANCE: 'Ví còn số dư. Hãy rút số dư (cần eKYC) hoặc liên hệ hỗ trợ trước khi xóa tài khoản.',
  PENDING_WITHDRAWAL: 'Có yêu cầu rút tiền đang xử lý. Vui lòng chờ hoàn tất.',
  OPEN_ORDERS: 'Có đơn hàng đã thanh toán nhưng chưa hoàn tất. Vui lòng chờ đơn hoàn tất hoặc hủy.',
  OPEN_DISPUTES: 'Có khiếu nại/tranh chấp đơn hàng đang mở.',
  OPEN_COMPLAINTS: 'Có hồ sơ khiếu nại đang được giải quyết.',
  ACTIVE_GPU: 'Có máy GPU đang chạy. Hãy dừng hoặc xóa máy trước.',
};

function evaluateDeletionBlockers(state = {}) {
  const n = (v) => Math.max(0, Number(v) || 0);
  const blockers = [];
  const add = (code, count) => blockers.push({ code, count, message: BLOCKER_MESSAGES[code] });
  if (n(state.walletBalance) >= BALANCE_EPSILON) add('WALLET_BALANCE', Math.round(n(state.walletBalance) * 100) / 100);
  if (n(state.pendingWithdrawals)) add('PENDING_WITHDRAWAL', n(state.pendingWithdrawals));
  if (n(state.openOrders)) add('OPEN_ORDERS', n(state.openOrders));
  if (n(state.openDisputes)) add('OPEN_DISPUTES', n(state.openDisputes));
  if (n(state.openComplaints)) add('OPEN_COMPLAINTS', n(state.openComplaints));
  if (n(state.activeGpu)) add('ACTIVE_GPU', n(state.activeGpu));
  return { canDelete: blockers.length === 0, blockers };
}

function isConfirmWord(v) {
  return CONFIRM_WORDS.includes(String(v || '').trim().toUpperCase());
}

function retentionUntil(now = new Date()) {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() + RETENTION_YEARS);
  return d;
}

function deletedEmail(userId) {
  return `deleted+${String(userId)}@deleted.aimarkets.invalid`;
}

/** KYC that was never submitted is personal data with no retention duty; submitted KYC is kept. */
function shouldRetainKyc(kyc) {
  const s = kyc?.status || 'none';
  return s !== 'none' && s !== 'draft';
}

/** Mongo update that turns a user into an anonymised tombstone. */
function anonymizedUserUpdate(user, now = new Date()) {
  const set = {
    email: deletedEmail(user._id),
    name: DELETED_NAME,
    passwordHash: '',
    authProvider: 'local',
    avatarUrl: '',
    coverUrl: '',
    bio: '',
    verified: false,
    wishlist: [],
    affiliateCode: '',
    profile: { introLine: '', region: '', website: '', notifyLang: 'vi', socials: [] },
    preferences: { personalizeContent: false, personalizeAds: false },
    accountStatus: 'deleted',
    statusReason: 'self_deleted',
    statusChangedAt: now,
    suspendedUntil: null,
    deletedAt: now,
    tokenVersion: (Number(user.tokenVersion) || 0) + 1,
  };
  const unset = { googleId: '', creatorSlug: '' };
  if (!shouldRetainKyc(user.kyc)) set.kyc = { status: 'none' };
  return { $set: set, $unset: unset };
}

/** What the app/web shows before the user confirms. */
function deletionNotice() {
  return {
    deleted: [
      'Hồ sơ cá nhân: tên, email, ảnh đại diện, ảnh bìa, giới thiệu, mạng xã hội, liên kết Google',
      'Mật khẩu, phiên đăng nhập và khóa API (bị thu hồi ngay)',
      'Giỏ hàng, danh sách yêu thích, thông báo, kết nối Git, khóa API nhà cung cấp (BYOK)',
      'Gian hàng và sản phẩm đang bán bị gỡ khỏi sàn; mã affiliate ngừng hoạt động',
      'Thuê bao agent ngừng tự gia hạn; dữ liệu agent bị xóa 30 ngày sau khi hết hạn',
    ],
    retained: [
      `Đơn hàng, hợp đồng, giao dịch ví, đối soát, hoàn tiền, hóa đơn: ${RETENTION_YEARS} năm kể từ ngày phát sinh (Quy chế Mục XIX, Chính sách lưu trữ dữ liệu)`,
      `Hồ sơ eKYC/xác minh người bán đã nộp: ${RETENTION_YEARS} năm sau khi chấm dứt`,
      `Khiếu nại, tranh chấp, quyết định xử lý vi phạm: ${RETENTION_YEARS} năm kể từ khi đóng`,
      'Chứng từ kế toán, thuế: theo thời hạn của pháp luật kế toán, thuế',
      'Các dữ liệu này được gắn với tài khoản đã ẩn danh và xóa khi hết thời hạn',
    ],
    irreversible: true,
    retentionYears: RETENTION_YEARS,
    publicRequestSlaDays: PUBLIC_REQUEST_SLA_DAYS,
    webUrl: 'https://aimarkets.vn/account/delete',
    policyUrl: 'https://aimarkets.vn/legal/chinh-sach-luu-tru-va-cung-cap-du-lieu',
  };
}

module.exports = {
  RETENTION_YEARS,
  PUBLIC_REQUEST_SLA_DAYS,
  CONFIRM_WORDS,
  DELETED_NAME,
  BLOCKER_MESSAGES,
  evaluateDeletionBlockers,
  isConfirmWord,
  retentionUntil,
  deletedEmail,
  shouldRetainKyc,
  anonymizedUserUpdate,
  deletionNotice,
};
