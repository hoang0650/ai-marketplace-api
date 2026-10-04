const LegalDocument = require('../models/LegalDocument');
const { LEGAL_DOCUMENT_TYPES } = LegalDocument;

const PLATFORM_NAME = 'AI Markets (aimarkets.vn)';
const OPERATOR = 'Công ty TNHH giải pháp công nghệ PHGroup (MST 3703279135)';
const FULL_TEXT = 'Toàn văn: https://aimarkets.vn/legal';

const BASE_DOCS = [
  {
    documentType: 'terms',
    title: 'Điều khoản sử dụng AI Markets',
    summary: 'Tài khoản, dịch vụ định kỳ, nội dung AI, hành vi cấm và giới hạn trách nhiệm.',
    content: `# Điều khoản sử dụng

${PLATFORM_NAME} do ${OPERATOR} vận hành theo mô hình sàn giao dịch TMĐT, đồng thời bán trực tiếp một số dịch vụ của nền tảng (Platform Direct).

- Người dùng chịu trách nhiệm bảo mật tài khoản; quản lý hồ sơ, thông báo, phiên đăng nhập trong Cài đặt.
- Dịch vụ định kỳ (thuê bao agent) tự gia hạn mặc định, có thể tắt; dịch vụ tính theo mức dùng (API, GPU, phút chơi game) trừ vào số dư theo đơn giá công bố.
- Nội dung do AI tạo được gắn nhãn; người dùng chịu trách nhiệm với nội dung mình yêu cầu tạo.
- Cấm các hành vi tại Chính sách sử dụng chấp nhận được.
- Thay đổi điều khoản được thông báo trước ít nhất 30 ngày. Pháp luật Việt Nam điều chỉnh.

${FULL_TEXT}/dieu-khoan-su-dung`,
  },
  {
    documentType: 'privacy',
    title: 'Chính sách bảo mật AI Markets',
    summary: 'Bảo vệ dữ liệu cá nhân theo Luật 91/2025/QH15 và Nghị định 356/2025/NĐ-CP.',
    content: `# Chính sách bảo mật

Dữ liệu cá nhân được xử lý theo Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 và Nghị định số 356/2025/NĐ-CP, chỉ cho mục đích: tài khoản, đơn hàng, thanh toán, xác minh người bán, an ninh, giải quyết khiếu nại và nghĩa vụ pháp luật.

- Ảnh giấy tờ tùy thân khi xác minh người bán là dữ liệu nhạy cảm, được giới hạn truy cập.
- Nội dung trao đổi với AI không dùng để huấn luyện mô hình; được chuyển tới nhà cung cấp mô hình để xử lý yêu cầu.
- Không bán dữ liệu cá nhân.
- Người dùng thực hiện quyền của chủ thể dữ liệu trong Cài đặt hoặc qua support@aimarkets.vn.

${FULL_TEXT}/chinh-sach-bao-mat-va-du-lieu`,
  },
  {
    documentType: 'marketplace-rules',
    title: 'Quy chế hoạt động sàn giao dịch TMĐT AI Markets',
    summary: 'Quy chế hoạt động theo Luật TMĐT 122/2025/QH15 và Nghị định 248/2026/NĐ-CP.',
    content: `# Quy chế hoạt động sàn giao dịch TMĐT

## 1. Căn cứ
Luật Thương mại điện tử số 122/2025/QH15; Nghị định số 248/2026/NĐ-CP; Luật Bảo vệ quyền lợi người tiêu dùng số 19/2023/QH15; Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15; Luật Trí tuệ nhân tạo số 134/2025/QH15; Nghị định số 252/2026/NĐ-CP về thuế.

## 2. Chủ thể
- **Người mua**: mua, sử dụng sản phẩm, dịch vụ.
- **Người bán**: bên thứ ba đã xác minh, đăng bán trên sàn.
- **Nền tảng**: ${OPERATOR}; là người bán khi sản phẩm gắn nhãn Platform Direct.
- **Nhà cung cấp hạ tầng** (GPU, mô hình AI, đám mây) không phải người bán.

## 3. Sản phẩm
Mô hình và API AI, agent, mẫu website/ứng dụng, giọng đọc AI, dịch vụ talent, thuê GPU, máy chủ chơi game theo phút. Phim, truyện/sách điện tử, dataset và tin tuyển dụng hiện chưa cung cấp.

## 4. Phí
- Phí dịch vụ sàn mặc định 20% giá trị giao dịch của người bán bên thứ ba; không phải thuế.
- Thuê bao agent 199.000 đ/30 ngày; phí token theo chi phí nhà cung cấp + 25%; BYOK không tính phí token.
- Phí cửa hàng Google Play / App Store khi thanh toán trong ứng dụng do Google/Apple thu.
- Thuế khấu trừ, nộp thay cho hộ, cá nhân kinh doanh theo Nghị định 252/2026/NĐ-CP.

## 5. Thanh toán và chi trả
Thanh toán qua GPay, Apple IAP, Google Play Billing hoặc ví AI Markets. Ví người mua không rút về ngân hàng. Tiền của người bán được giữ 48 giờ, chỉ chi trả khi không có tranh chấp và người bán đã xác minh. Cấm giao dịch ngoài sàn.

## 6. Khiếu nại
Tiếp nhận trong 24 giờ, giải quyết trong 07 ngày làm việc.

## 7. Thay đổi
Thông báo trước ít nhất 30 ngày. Pháp luật Việt Nam điều chỉnh.

${FULL_TEXT}/quy-che-hoat-dong-san-tmdt`,
  },
  {
    documentType: 'seller-policy',
    title: 'Chính sách người bán',
    summary: 'Điều kiện đăng bán, phí sàn 20%, phí cửa hàng, thuế theo NĐ 252/2026, giữ tiền 48 giờ.',
    content: `# Chính sách người bán

## Điều kiện
- Hồ sơ xác minh được duyệt (giấy tờ tùy thân, mã số thuế, tài khoản nhận tiền đứng tên mình).
- Xác nhận Chính sách người bán và Thỏa thuận người bán phiên bản hiện hành.
- Sản phẩm qua kiểm duyệt trước khi hiển thị; không bán hàng thuộc danh mục cấm.

## Phí
- Phí dịch vụ sàn mặc định **20%**, không phải thuế.
- Thanh toán trong ứng dụng: phí Google Play (thường 15%) / App Store (thường 30%) do cửa hàng thu, không phải doanh thu sàn.
- Sản phẩm Platform Direct không áp dụng chia sẻ doanh thu.
- Mỗi đơn lưu ảnh chụp tỷ lệ phí tại thời điểm giao dịch.

## Thuế
Sàn khấu trừ, nộp thay thuế GTGT, TNCN cho người bán là hộ, cá nhân kinh doanh theo Nghị định 252/2026/NĐ-CP, theo tỷ lệ pháp luật quy định cho từng loại hàng hóa, dịch vụ; số tiền thể hiện trên đối soát từng đơn. Người bán là doanh nghiệp, tổ chức tự kê khai.

## Chi trả
Tiền của người bán được giữ **48 giờ** sau khi đơn hoàn tất; chi trả khi không có tranh chấp mở và người bán đã xác minh.

${FULL_TEXT}/chinh-sach-nguoi-ban`,
  },
  {
    documentType: 'seller-agreement',
    title: 'Thỏa thuận người bán AI Markets',
    summary: 'Hợp đồng điện tử giữa sàn và người bán: phí, đối soát, rút tiền.',
    content: `# Thỏa thuận người bán

Bằng việc xác nhận, người bán đồng ý:
1. Tuân thủ Quy chế hoạt động sàn và pháp luật Việt Nam.
2. Cung cấp thông tin xác minh trung thực; cập nhật khi thay đổi.
3. Chỉ bán sản phẩm có quyền hợp pháp, qua kiểm duyệt, không thuộc danh mục cấm.
4. Chịu phí dịch vụ sàn (mặc định 20%) và phí cửa hàng ứng dụng khi thanh toán trong ứng dụng, theo ảnh chụp đơn.
5. Để sàn khấu trừ, nộp thay thuế theo Nghị định 252/2026/NĐ-CP nếu là hộ, cá nhân kinh doanh.
6. Tiền được giữ 48 giờ; chỉ rút khi không có tranh chấp mở và đã xác minh.
7. Không thu tiền ngoài sàn cho giao dịch phát sinh trên sàn.
8. Chấp nhận biện pháp xử lý vi phạm; sửa đổi thỏa thuận được thông báo trước 30 ngày.

${FULL_TEXT}/mau-hop-dong-cung-cap-dich-vu-nguoi-ban`,
  },
  {
    documentType: 'buyer-policy',
    title: 'Chính sách người mua',
    summary: 'Quyền, nghĩa vụ người mua; GPU, phút chơi game, thuê bao agent và talent.',
    content: `# Chính sách người mua

- Kiểm tra nhãn **Bán bởi sàn** hoặc **Bán bởi người bán**, giá và đơn vị tính trước khi đặt hàng.
- Giỏ hàng, yêu thích đồng bộ giữa web và ứng dụng khi đăng nhập.
- Thuê GPU: trả trước tối thiểu 1 giờ, tính theo phút, cảnh báo trước 10 phút khi sắp hết số dư, tự dừng khi hết tiền, xóa sau 24 giờ.
- Chơi game: cần số dư tối thiểu 1 phút, tính theo phút, tự dừng sau 5 phút không thao tác.
- Thuê bao agent: 199.000 đ/30 ngày, nhắc trước 3 ngày, trừ tiền trước 24 giờ; hết hạn thì khóa agent, giữ dữ liệu 30 ngày.
- Nên khiếu nại đơn hàng trong 48 giờ để tiền của người bán được tạm giữ trong lúc xem xét.

${FULL_TEXT}/chinh-sach-nguoi-mua`,
  },
  {
    documentType: 'payment-policy',
    title: 'Chính sách thanh toán và đối soát',
    summary: 'GPay, Apple/Google IAP, ví không rút được, đối soát và cấm giao dịch ngoài sàn.',
    content: `# Chính sách thanh toán và đối soát

## Phương thức
GPay (web), Apple In-App Purchase, Google Play Billing, ví AI Markets.

## Ví người mua
Dùng để thanh toán trên sàn; **không rút về ngân hàng**. Tiền hoàn trả về ví hoặc phương thức thanh toán ban đầu.

## Sổ cái
Mỗi đơn ghi phí dịch vụ sàn, phí cửa hàng ứng dụng, thuế khấu trừ (nếu có) và phần người bán được nhận; đơn đã chốt không bị tính lại khi tỷ lệ thay đổi.

## Chi trả người bán
Giữ 48 giờ sau khi đơn hoàn tất; chi trả về tài khoản ngân hàng đứng tên người bán đã xác minh khi không có tranh chấp.

## Cấm giao dịch ngoài sàn
Không yêu cầu, nhận thanh toán ngoài hệ thống cho giao dịch phát sinh trên sàn.

${FULL_TEXT}/chinh-sach-thanh-toan-doi-soat`,
  },
  {
    documentType: 'refund-policy',
    title: 'Chính sách hoàn tiền và chấm dứt dịch vụ',
    summary: 'Điều kiện hoàn theo loại sản phẩm, thời hạn 48 giờ và chấm dứt dịch vụ.',
    content: `# Chính sách hoàn tiền

Không áp dụng đổi trả chung 30 ngày cho sản phẩm số.

- Sản phẩm cấp phép: hoàn khi không giao được hoặc không đúng mô tả.
- Dịch vụ tính theo mức dùng, GPU, phút chơi game đã sử dụng: không hoàn.
- Thuê bao agent: không hoàn theo tỷ lệ ngày còn lại; hoàn khi lỗi từ nền tảng; phí token đã dùng không hoàn.
- Talent: theo từng mốc công việc.
- Thanh toán trong ứng dụng: hoàn qua Apple/Google theo chính sách của cửa hàng.

Nên gửi yêu cầu trong 48 giờ để tiền của người bán được tạm giữ trong lúc xem xét; yêu cầu sau thời hạn này vẫn được tiếp nhận. Tiếp nhận trong 24 giờ, giải quyết trong 07 ngày làm việc.

${FULL_TEXT}/chinh-sach-hoan-tien`,
  },
  {
    documentType: 'dispute-policy',
    title: 'Chính sách tranh chấp',
    summary: 'Quy trình tranh chấp người mua – người bán – nền tảng.',
    content: `# Chính sách tranh chấp

Loại tranh chấp: người mua – người bán, người mua – nền tảng, người bán – nền tảng.
Tranh chấp mở trong 48 giờ sau khi đơn hoàn tất sẽ tạm giữ tiền của người bán. Sàn xem xét bằng chứng của các bên và quyết định trong 07 ngày làm việc: hoàn tiền, giải phóng tiền cho người bán hoặc hòa giải. Các bên được yêu cầu xem xét lại trong 07 ngày. Mọi quyết định được ghi nhật ký.

${FULL_TEXT}/chinh-sach-khieu-nai-tranh-chap`,
  },
  {
    documentType: 'complaint-policy',
    title: 'Chính sách khiếu nại',
    summary: 'Tiếp nhận trong 24 giờ, giải quyết trong 07 ngày làm việc.',
    content: `# Chính sách khiếu nại

Gửi khiếu nại tại https://aimarkets.vn/complaints, email support@aimarkets.vn hoặc hotline 1900 6159.

1. Xác nhận tiếp nhận trong **24 giờ**.
2. Xác minh thông tin.
3. Người bán phản hồi (nếu liên quan).
4. Ra quyết định trong **07 ngày làm việc** kể từ khi tiếp nhận.
5. Thực hiện hoàn tiền hoặc giải phóng tiền; đóng hồ sơ.

${FULL_TEXT}/chinh-sach-khieu-nai-tranh-chap`,
  },
  {
    documentType: 'intellectual-property',
    title: 'Chính sách sở hữu trí tuệ và giấy phép',
    summary: 'Quyền SHTT, thông báo và gỡ bỏ, phạm vi quyền người mua.',
    content: `# Sở hữu trí tuệ

Người bán cam kết có quyền phân phối mô hình, agent, API, mẫu website, giọng đọc (có văn bản đồng ý của người có giọng nói đối với giọng nhân bản). Thông báo xâm phạm được xử lý theo quy trình thông báo và gỡ bỏ; yêu cầu của cơ quan có thẩm quyền được xử lý trong 24 giờ. Người mua được sử dụng theo giấy phép của từng sản phẩm, không bán lại khi giấy phép không cho phép.

${FULL_TEXT}/chinh-sach-ip-ban-quyen-license`,
  },
  {
    documentType: 'acceptable-use',
    title: 'Chính sách sử dụng chấp nhận được',
    summary: 'Danh mục cấm kinh doanh, hành vi cấm trên API, GPU và agent.',
    content: `# Sử dụng chấp nhận được

Cấm kinh doanh: hàng hóa, dịch vụ cấm theo pháp luật; cờ bạc; mua bán dữ liệu cá nhân; deepfake, giả mạo giọng nói, hình ảnh không có đồng ý; ngành nghề có điều kiện khi chưa có giấy phép.
Cấm sử dụng: mã độc, tấn công hạ tầng, gian lận thanh toán, đào tiền mã hóa trên tài nguyên thuê khi không được phép, thu thập dữ liệu trái phép, lạm dụng agent và kênh nhắn tin để gửi tin rác.

${FULL_TEXT}/chinh-sach-su-dung-chap-nhan-duoc`,
  },
  {
    documentType: 'data-policy',
    title: 'Chính sách lưu trữ và cung cấp dữ liệu',
    summary: 'Thời hạn lưu trữ, tạm giữ và cung cấp dữ liệu cho cơ quan có thẩm quyền.',
    content: `# Chính sách dữ liệu

- Thông tin sản phẩm đã đăng: lưu tối thiểu 01 năm.
- Hợp đồng, đơn hàng, thanh toán, khiếu nại: lưu tối thiểu 03 năm.
- Dữ liệu agent sau khi thuê bao hết hạn: 30 ngày; ổ đĩa GPU sau khi xóa máy: tối đa 24 giờ.
- Dữ liệu liên quan tranh chấp, điều tra được tạm giữ đến khi kết thúc.
- Cung cấp dữ liệu theo yêu cầu bằng văn bản của cơ quan có thẩm quyền; gỡ bỏ, tạm ngừng trong 24 giờ khi được yêu cầu.

${FULL_TEXT}/chinh-sach-luu-tru-va-cung-cap-du-lieu`,
  },
  {
    documentType: 'tax-policy',
    title: 'Chính sách thuế AI Markets',
    summary: 'Khấu trừ, nộp thay thuế cho hộ, cá nhân kinh doanh theo NĐ 252/2026/NĐ-CP.',
    content: `# Chính sách thuế

## Phí dịch vụ sàn không phải thuế
Phí dịch vụ sàn (mặc định 20%) là doanh thu của nền tảng, không phải thuế của người bán.

## Khấu trừ, nộp thay
Theo Nghị định 252/2026/NĐ-CP, sàn khấu trừ, nộp thay thuế GTGT, TNCN đối với người bán là **hộ, cá nhân kinh doanh**, theo tỷ lệ pháp luật quy định cho từng nhóm hàng hóa, dịch vụ và tình trạng cư trú. Số thuế khấu trừ thể hiện trên đối soát từng đơn và chứng từ khấu trừ.

## Người bán là doanh nghiệp, tổ chức
Không khấu trừ; người bán tự kê khai, nộp thuế.

## Phí cửa hàng ứng dụng
Phí Google Play / App Store là phí của cửa hàng, không phải thuế, không phải phí sàn.

## Thay đổi
Thay đổi tỷ lệ theo pháp luật chỉ áp dụng cho giao dịch mới.

${FULL_TEXT}/chinh-sach-thue`,
  },
  {
    documentType: 'invoice-policy',
    title: 'Chính sách hóa đơn AI Markets',
    summary: 'Phân biệt hóa đơn phí dịch vụ của sàn và hóa đơn của người bán.',
    content: `# Chính sách hóa đơn

- **Hóa đơn của sàn**: phí dịch vụ sàn và sản phẩm Platform Direct.
- **Hóa đơn của người bán**: hàng hóa, dịch vụ do người bán bên thứ ba cung cấp; với hộ, cá nhân kinh doanh áp dụng theo Nghị định 252/2026/NĐ-CP.
- Doanh nghiệp cần hóa đơn gửi yêu cầu tới support@aimarkets.vn kèm tên, mã số thuế, địa chỉ và mã đơn.
- Thanh toán trong ứng dụng: biên nhận do Apple/Google phát hành.

${FULL_TEXT}/chinh-sach-hoa-don`,
  },
];

async function ensureLegalDocuments() {
  const version = '2026.10.04';
  const effectiveAt = new Date('2026-10-04T00:00:00.000Z');
  let created = 0;
  let skipped = 0;

  for (const doc of BASE_DOCS) {
    const existing = await LegalDocument.findOne({
      documentType: doc.documentType,
      version,
      locale: 'vi',
    });
    if (existing) {
      skipped += 1;
      continue;
    }
    await LegalDocument.create({
      ...doc,
      version,
      locale: 'vi',
      effectiveAt,
      publishedAt: new Date(),
      status: 'published',
    });
    created += 1;
  }

  return { created, skipped, version, types: LEGAL_DOCUMENT_TYPES };
}

module.exports = { ensureLegalDocuments, BASE_DOCS };
