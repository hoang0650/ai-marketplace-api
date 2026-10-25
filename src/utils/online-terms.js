'use strict';
/**
 * AI Markets Online License (AIM-OL) — the proprietary terms for online-only products
 * (datasets, skill packs, AI film series, story books). Applied as the default license /
 * termsSummary of new listings in these categories; listing one means the seller accepts that
 * the product is distributed to buyers under these terms (recorded in product.onlineTerms).
 * Full text: website Terms of Service, section "AI Markets Online License".
 */
const { isOnlineOnlyCategory } = require('./online-access');

const ONLINE_TERMS_VERSION = 'AIM-OL-1.0';
const ONLINE_TERMS_URL = 'https://www.aimarkets.vn/terms-of-service#online-license';

const ONLINE_LICENSE =
  'AI Markets Online License (AIM-OL 1.0) – online-only, non-transferable, non-sublicensable, for the license period';

const ONLINE_TERMS = {
  vi:
    'Giấy phép trực tuyến AI Markets (AIM-OL 1.0): quyền sử dụng không độc quyền, không chuyển nhượng, không cấp phép lại, chỉ trong thời hạn giấy phép đã mua. ' +
    'Chỉ truy cập qua API, trình phát/trình đọc trực tuyến hoặc trình chạy skill của AI Markets; không tải về, không phân phối lại, không sao chép hàng loạt, cào dữ liệu hay tái dựng sản phẩm. ' +
    'Nội dung có watermark/mã truy vết gắn với tài khoản và giấy phép. Quyền truy cập chấm dứt khi giấy phép hết hạn hoặc bị thu hồi do vi phạm. ' +
    'Skill chạy trên máy chủ AI Markets trong môi trường cách ly; dữ liệu đầu vào/đầu ra của mỗi lần chạy bị xóa ngay sau khi chạy xong.',
  en:
    'AI Markets Online License (AIM-OL 1.0): non-exclusive, non-transferable, non-sublicensable right of use for the purchased license period only. ' +
    'Access only through the AI Markets API, online player/reader or skill runner; no downloading, redistribution, bulk copying, scraping or reconstruction of the product. ' +
    'Content carries a watermark/trace ID linked to your account and license. Access ends when the license expires or is revoked for breach. ' +
    'Skills run on AI Markets servers in an isolated sandbox; each run’s inputs and outputs are deleted right after the run.',
  zh:
    'AI Markets 在线许可（AIM-OL 1.0）：仅在所购许可期内享有非独占、不可转让、不可再许可的使用权。' +
    '仅可通过 AI Markets API、在线播放器/阅读器或技能运行器访问；不得下载、再分发、批量复制、抓取或重建本产品。' +
    '内容带有与您的账户和许可关联的水印/追踪码。许可到期或因违约被撤销时，访问即终止。' +
    '技能在 AI Markets 服务器的隔离沙箱中运行，每次运行的输入与输出在运行结束后立即删除。',
};

const ONLINE_TERMS_SUMMARY = [ONLINE_TERMS.vi, ONLINE_TERMS.en, ONLINE_TERMS.zh].join('\n\n');

/** Upstream open-source notice appended for listings that contain third-party MIT data. */
function upstreamMitNotice({ holder, year, file }) {
  return [
    `Dữ liệu gốc MIT © ${year} ${holder}: bộ dữ liệu là tác phẩm phái sinh, cấp phép lại theo MIT; giữ nguyên thông báo ${file}. AIM-OL không hạn chế quyền với dữ liệu gốc lấy từ nguồn MIT.`,
    `Upstream data MIT © ${year} ${holder}: derivative work sublicensed under MIT; notice ${file} preserved. AIM-OL does not limit rights in the upstream data obtained from its MIT source.`,
    `上游数据 MIT © ${year} ${holder}：本数据集为衍生作品，依 MIT 再许可，保留 ${file}。AIM-OL 不限制您对从 MIT 原始来源获取的上游数据的权利。`,
  ].join('\n');
}

function usesOnlineTerms(category) {
  return isOnlineOnlyCategory(category);
}

/**
 * Fill license / termsSummary defaults and record seller acceptance for online-only categories.
 * Returns { error } when the seller explicitly declined (acceptOnlineTerms === false).
 */
function applyOnlineTerms(target, body = {}, user = null, { now = new Date() } = {}) {
  if (!usesOnlineTerms(target.category)) return {};
  if (body.acceptOnlineTerms === false) {
    return {
      error: {
        message: 'Sản phẩm dataset/skill/phim/truyện được phân phối theo Giấy phép trực tuyến AI Markets (AIM-OL). Bạn cần đồng ý điều khoản này để đăng bán.',
        code: 'ONLINE_TERMS_REQUIRED',
        termsVersion: ONLINE_TERMS_VERSION,
        termsUrl: ONLINE_TERMS_URL,
      },
    };
  }
  const isAdmin = user && user.role === 'admin';
  // Sellers cannot pick a conflicting license for these categories; admins (platform listings)
  // may add an upstream notice, e.g. an MIT attribution.
  if (!isAdmin || !String(target.license || '').trim()) target.license = ONLINE_LICENSE;
  const extra = String(body.termsSummary || '').trim();
  target.termsSummary = extra && !extra.includes('AIM-OL')
    ? `${ONLINE_TERMS_SUMMARY}\n\n${extra}`.slice(0, 2000)
    : (extra || ONLINE_TERMS_SUMMARY).slice(0, 2000);
  if (!target.onlineTerms || target.onlineTerms.version !== ONLINE_TERMS_VERSION) {
    target.onlineTerms = {
      version: ONLINE_TERMS_VERSION,
      acceptedAt: now,
      acceptedBy: user ? user._id : null,
      explicit: body.acceptOnlineTerms === true,
    };
  }
  return {};
}

module.exports = {
  ONLINE_TERMS_VERSION,
  ONLINE_TERMS_URL,
  ONLINE_LICENSE,
  ONLINE_TERMS,
  ONLINE_TERMS_SUMMARY,
  upstreamMitNotice,
  usesOnlineTerms,
  applyOnlineTerms,
};
