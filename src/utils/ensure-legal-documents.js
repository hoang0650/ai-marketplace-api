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
- Mọi đơn hàng được thanh toán bằng số dư ví AI Markets; ví được nạp qua GPay/VietQR (web), Apple In-App Purchase hoặc Google Play Billing (ứng dụng). Giá và số dư hiển thị theo VNĐ, USD hoặc CNY do người dùng chọn.
- Dịch vụ định kỳ (thuê bao agent 199.000 đ/30 ngày) tự gia hạn mặc định, có thể tắt; dịch vụ tính theo mức dùng (API, GPU, phút chơi game) trừ vào số dư theo đơn giá công bố.
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
- Cơ sở dữ liệu và dữ liệu cá nhân được lưu trữ tại Việt Nam trên máy chủ của Công ty TNHH Lưu Trữ Số (123HOST, MST 0312088232); chỉ chuyển ra nước ngoài trong phạm vi cần thiết để cung cấp dịch vụ (ví dụ nhà cung cấp mô hình AI) theo quy định pháp luật.
- Ảnh CCCD/hộ chiếu khi người mua rút số dư ví và giấy chứng nhận đăng ký kinh doanh của người bán là hộ kinh doanh, doanh nghiệp được giới hạn truy cập.
- Không bán dữ liệu cá nhân.
- Người dùng thực hiện quyền của chủ thể dữ liệu trong Cài đặt hoặc qua support@aimarkets.vn.

${FULL_TEXT}/chinh-sach-bao-mat-va-du-lieu`,
  },
  {
    documentType: 'marketplace-rules',
    title: 'Quy chế hoạt động sàn giao dịch TMĐT AI Markets',
    summary: 'Quy chế hoạt động phiên bản 2.1, hiệu lực từ 05/10/2026, theo Luật TMĐT 122/2025/QH15 và Nghị định 248/2026/NĐ-CP.',
    content: `# Quy chế hoạt động sàn giao dịch TMĐT

Phiên bản 2.1 — hiệu lực từ ngày 05/10/2026. Bản tóm tắt; toàn văn tại đường dẫn cuối trang.

## 1. Căn cứ
Luật Thương mại điện tử số 122/2025/QH15; Nghị định số 248/2026/NĐ-CP; Luật Bảo vệ quyền lợi người tiêu dùng số 19/2023/QH15; Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15; Luật Trí tuệ nhân tạo số 134/2025/QH15; Nghị định số 252/2026/NĐ-CP về thuế.

## 2. Chủ thể
- **Người mua**: mua, sử dụng sản phẩm, dịch vụ.
- **Người bán**: bên thứ ba đã xác minh, đăng bán trên sàn.
- **Nền tảng**: ${OPERATOR}; là người bán khi sản phẩm gắn nhãn Platform Direct.
- **Nhà cung cấp hạ tầng** (GPU, mô hình AI, đám mây) không phải người bán.

## 3. Sản phẩm
Mô hình và API AI, agent, gói kỹ năng, phần mềm, mẫu website/ứng dụng, giọng đọc AI, phim AI, truyện/sách AI (license xem/đọc theo thời hạn), dataset, thuê GPU, máy chủ chơi game theo phút và dịch vụ chuyên môn trọn gói (làm web, làm app, marketing, SEO, creator, tự động hóa) bán theo gói giá cố định. Sàn không cung cấp tin tuyển dụng, đăng việc, hồ sơ ứng viên hay dịch vụ tính theo giờ/tháng.

## 4. Phí
- Phí dịch vụ sàn mặc định 20% giá trị đơn hàng sau giảm giá của người bán bên thứ ba; không phải thuế. Mã giảm giá được trừ trước khi tính phí sàn.
- Thuế khấu trừ cố định 8% giá trị đơn hàng, áp dụng cho mọi người bán. Tổng khấu trừ 28%; số dư hiển thị của người bán là số dư ròng.
- Phí kho ứng dụng (Google Play 15%, App Store 30%) đối với giao dịch trong ứng dụng do Google/Apple thu; không phải phí sàn.
- Thuê bao agent 199.000 đ/30 ngày; phí token theo chi phí nhà cung cấp + 25%; BYOK không tính phí token.
- Thay đổi phí được thông báo trước ít nhất 30 ngày và chỉ áp dụng cho đơn hàng mới.

## 5. Thanh toán và chi trả
Mọi đơn hàng được thanh toán bằng số dư ví AI Markets. GPay/VietQR, Apple IAP và Google Play Billing chỉ dùng để nạp tiền vào ví. Người mua được rút số dư ví sau khi xác minh danh tính (eKYC). Tiền của người bán được giữ 48 giờ, chỉ chi trả khi không có tranh chấp và người bán đã xác minh (bao gồm eKYC). Cấm giao dịch ngoài sàn.

## 6. Khiếu nại
Xác nhận tiếp nhận trong 24 giờ; xác minh sơ bộ trong 01 ngày làm việc; người bán phản hồi trong 02 ngày làm việc; ra quyết định trong 07 ngày làm việc kể từ khi đủ hồ sơ. Khiếu nại lại trong 07 ngày kể từ khi có quyết định, được trả lời trong 07 ngày làm việc.

## 7. Dữ liệu
Cơ sở dữ liệu và dữ liệu cá nhân được lưu trữ tại Việt Nam trên máy chủ của Công ty TNHH Lưu Trữ Số (123HOST, MST 0312088232).

## 8. Thay đổi
Thông báo trước ít nhất 30 ngày. Pháp luật Việt Nam điều chỉnh.

${FULL_TEXT}/quy-che-hoat-dong-san-tmdt`,
  },
  {
    documentType: 'seller-policy',
    title: 'Chính sách người bán',
    summary: 'Điều kiện đăng bán, eKYC, giấy chứng nhận đăng ký kinh doanh, phí sàn 20%, thuế 8%, giữ tiền 48 giờ.',
    content: `# Chính sách người bán

## Điều kiện
- Hồ sơ xác minh được duyệt (giấy tờ tùy thân, mã số thuế, tài khoản nhận tiền đứng tên mình). Hộ kinh doanh tải lên giấy chứng nhận đăng ký hộ kinh doanh; doanh nghiệp, tổ chức tải lên giấy chứng nhận đăng ký doanh nghiệp hoặc giấy phép tương đương.
- Hoàn tất xác minh danh tính (eKYC) trước khi hồ sơ được phê duyệt và trước khi rút tiền. Từ ngày 01/01/2027, định danh, xác thực điện tử thực hiện qua VNeID theo quy định.
- Xác nhận Chính sách người bán và Thỏa thuận người bán phiên bản hiện hành.
- Sản phẩm qua kiểm duyệt trước khi hiển thị; không bán hàng thuộc danh mục cấm.

## Phí
- Phí dịch vụ sàn mặc định **20%** giá trị đơn hàng sau giảm giá, không phải thuế; mã giảm giá được trừ trước khi tính phí sàn.
- Thuế khấu trừ cố định **8%** áp dụng cho mọi người bán; tổng khấu trừ **28%**, số dư hiển thị là số dư ròng.
- Thanh toán trong ứng dụng: phí Google Play 15% / App Store 30% do cửa hàng thu, không phải doanh thu sàn.
- Thay đổi phí được thông báo trước ít nhất 30 ngày.
- Sản phẩm Platform Direct không áp dụng chia sẻ doanh thu.
- Mỗi đơn lưu ảnh chụp tỷ lệ phí tại thời điểm giao dịch.

## Thuế
Sàn khấu trừ cố định 8% giá trị đơn hàng (tương đương 10% trên phần 80% doanh thu của người bán) đối với mọi người bán khi đơn hàng hoàn tất; số tiền thể hiện trên đối soát từng đơn. Người bán tự chịu trách nhiệm các nghĩa vụ thuế khác và xuất hóa đơn theo quy định.

## Chi trả
Tiền của người bán được giữ **48 giờ** sau khi đơn hoàn tất; chi trả khi không có tranh chấp mở và người bán đã xác minh (bao gồm eKYC).

${FULL_TEXT}/chinh-sach-nguoi-ban`,
  },
  {
    documentType: 'seller-agreement',
    title: 'Thỏa thuận cung cấp dịch vụ người bán AI Markets',
    summary: 'Phiên bản v2026.10.05: phí sàn 20%, thuế 8%, đối soát, eKYC và rút tiền.',
    content: `# Thỏa thuận cung cấp dịch vụ người bán

Phiên bản v2026.10.05 — hiệu lực từ ngày 05/10/2026. Bằng việc xác nhận, người bán đồng ý:
1. Tuân thủ Quy chế hoạt động sàn và pháp luật Việt Nam.
2. Cung cấp thông tin xác minh trung thực (eKYC; giấy chứng nhận đăng ký hộ kinh doanh/doanh nghiệp nếu có); cập nhật khi thay đổi.
3. Chỉ bán sản phẩm có quyền hợp pháp, qua kiểm duyệt, không thuộc danh mục cấm; dịch vụ chuyên môn bán theo gói giá cố định.
4. Chịu phí dịch vụ sàn 20% giá trị đơn hàng sau giảm giá và phí kho ứng dụng (Google Play 15%, App Store 30%) khi thanh toán trong ứng dụng, theo ảnh chụp đơn.
5. Để sàn khấu trừ thuế cố định 8% giá trị đơn hàng; tổng khấu trừ 28%.
6. Tiền được giữ 48 giờ; chỉ rút khi không có tranh chấp mở và đã xác minh (bao gồm eKYC).
7. Không thu tiền ngoài sàn cho giao dịch phát sinh trên sàn.
8. Chấp nhận biện pháp xử lý vi phạm; sửa đổi thỏa thuận được thông báo trước 30 ngày.

${FULL_TEXT}/mau-hop-dong-cung-cap-dich-vu-nguoi-ban`,
  },
  {
    documentType: 'buyer-policy',
    title: 'Chính sách người mua',
    summary: 'Quyền, nghĩa vụ người mua; thanh toán bằng ví, rút số dư sau eKYC, GPU, chơi game, thuê bao agent.',
    content: `# Chính sách người mua

- Kiểm tra nhãn **Bán bởi sàn** hoặc **Bán bởi người bán**, giá và đơn vị tính trước khi đặt hàng.
- Mọi đơn hàng được thanh toán bằng số dư ví; nạp ví qua GPay/VietQR (web), Apple IAP hoặc Google Play Billing (ứng dụng). Giá hiển thị theo VNĐ, USD hoặc CNY; mã giảm giá hiển thị là “Giảm giá từ sàn” trong giỏ hàng.
- Người mua được rút số dư ví sau khi xác minh danh tính (eKYC) bằng CCCD/hộ chiếu.
- Dịch vụ chuyên môn (làm web, làm app, marketing, SEO, creator, tự động hóa) bán theo gói giá cố định, thanh toán như sản phẩm khác.
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
    summary: 'Thanh toán bằng ví; GPay, Apple/Google IAP chỉ để nạp ví; rút ví sau eKYC; đối soát.',
    content: `# Chính sách thanh toán và đối soát

## Phương thức
Mọi đơn hàng được thanh toán bằng **số dư ví AI Markets**. GPay/VietQR (web), Apple In-App Purchase và Google Play Billing (ứng dụng) chỉ dùng để nạp tiền vào ví. Số dư hiển thị theo VNĐ, USD hoặc CNY.

## Ví người mua
Dùng để thanh toán trên sàn; được **rút về tài khoản ngân hàng đứng tên mình sau khi xác minh danh tính (eKYC)**. Tiền hoàn trả về ví hoặc phương thức thanh toán ban đầu.

## Sổ cái
Mỗi đơn ghi giá, giảm giá (trừ trước phí sàn), phí dịch vụ sàn 20%, phí kho ứng dụng (nếu có), thuế khấu trừ 8% và phần người bán được nhận; đơn đã chốt không bị tính lại khi tỷ lệ thay đổi.

## Chi trả người bán
Giữ 48 giờ sau khi đơn hoàn tất; chi trả về tài khoản ngân hàng đứng tên người bán đã xác minh (bao gồm eKYC) khi không có tranh chấp.

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
- Dịch vụ chuyên môn trọn gói: hoàn khi không bàn giao hoặc không đúng mô tả gói.
- Nạp ví qua Apple/Google: hoàn giao dịch nạp theo chính sách của cửa hàng.

Nên gửi yêu cầu trong 48 giờ để tiền của người bán được tạm giữ trong lúc xem xét; yêu cầu sau thời hạn này vẫn được tiếp nhận. Xác nhận tiếp nhận trong 24 giờ, ra quyết định trong 07 ngày làm việc kể từ khi đủ hồ sơ.

${FULL_TEXT}/chinh-sach-hoan-tien`,
  },
  {
    documentType: 'dispute-policy',
    title: 'Chính sách tranh chấp',
    summary: 'Quy trình tranh chấp người mua – người bán – nền tảng.',
    content: `# Chính sách tranh chấp

Loại tranh chấp: người mua – người bán, người mua – nền tảng, người bán – nền tảng.
Tranh chấp mở trong 48 giờ sau khi đơn hoàn tất sẽ tạm giữ tiền của người bán. Sàn xem xét bằng chứng của các bên và quyết định trong 07 ngày làm việc: hoàn tiền, giải phóng tiền cho người bán hoặc hòa giải. Các bên được khiếu nại lại trong 07 ngày kể từ khi có quyết định; sàn trả lời trong 07 ngày làm việc. Mọi quyết định được ghi nhật ký.

${FULL_TEXT}/chinh-sach-khieu-nai-tranh-chap`,
  },
  {
    documentType: 'complaint-policy',
    title: 'Chính sách khiếu nại',
    summary: 'Tiếp nhận 24 giờ, xác minh 01 ngày làm việc, người bán phản hồi 02 ngày làm việc, quyết định 07 ngày làm việc.',
    content: `# Chính sách khiếu nại

Gửi khiếu nại tại https://aimarkets.vn/complaints, email support@aimarkets.vn hoặc hotline 1900 6159.

1. Xác nhận tiếp nhận trong **24 giờ**.
2. Xác minh sơ bộ trong **01 ngày làm việc**.
3. Người bán phản hồi trong **02 ngày làm việc** kể từ khi được thông báo (nếu liên quan).
4. Ra quyết định trong **07 ngày làm việc** kể từ khi đủ hồ sơ.
5. Thực hiện hoàn tiền hoặc giải phóng tiền; đóng hồ sơ.
6. Khiếu nại lại trong **07 ngày** kể từ khi có quyết định; sàn trả lời trong **07 ngày làm việc**.

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

- Cơ sở dữ liệu và dữ liệu cá nhân lưu trữ tại Việt Nam trên máy chủ của Công ty TNHH Lưu Trữ Số (123HOST, MST 0312088232).
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
    summary: 'Thuế khấu trừ cố định 8% cho mọi người bán; tổng khấu trừ cùng phí sàn 28%.',
    content: `# Chính sách thuế

## Phí dịch vụ sàn không phải thuế
Phí dịch vụ sàn (mặc định 20% giá trị đơn hàng sau giảm giá) là doanh thu của nền tảng, không phải thuế của người bán.

## Khấu trừ
Sàn khấu trừ thuế **cố định 8%** giá trị đơn hàng (tương đương 10% trên phần 80% doanh thu của người bán) đối với **mọi người bán** (cá nhân, hộ kinh doanh, doanh nghiệp, tổ chức) khi đơn hàng hoàn tất. Tổng khấu trừ = phí sàn 20% + thuế 8% = **28%**; số dư hiển thị là số dư ròng. Số thuế khấu trừ thể hiện trên đối soát từng đơn.

## Nghĩa vụ khác
Khoản khấu trừ 8% không thay thế các nghĩa vụ thuế khác; người bán tự kê khai, quyết toán và xuất hóa đơn theo quy định.

## Phí cửa hàng ứng dụng
Phí Google Play / App Store là phí của cửa hàng, không phải thuế, không phải phí sàn.

## Thay đổi
Thay đổi tỷ lệ được thông báo trước ít nhất 30 ngày và chỉ áp dụng cho giao dịch mới.

${FULL_TEXT}/chinh-sach-thue`,
  },
  {
    documentType: 'invoice-policy',
    title: 'Chính sách hóa đơn AI Markets',
    summary: 'Phân biệt hóa đơn phí dịch vụ của sàn và hóa đơn của người bán.',
    content: `# Chính sách hóa đơn

- **Hóa đơn của sàn**: phí dịch vụ sàn và sản phẩm Platform Direct.
- **Hóa đơn của người bán**: hàng hóa, dịch vụ do người bán bên thứ ba cung cấp, do người bán xuất theo quy định.
- Doanh nghiệp cần hóa đơn gửi yêu cầu tới support@aimarkets.vn kèm tên, mã số thuế, địa chỉ và mã đơn.
- Nạp ví trong ứng dụng: biên nhận giao dịch nạp do Apple/Google phát hành.

${FULL_TEXT}/chinh-sach-hoa-don`,
  },
];

async function ensureLegalDocuments() {
  const version = '2026.10.05';
  const effectiveAt = new Date('2026-10-05T00:00:00.000Z');
  let created = 0;
  let skipped = 0;
  let updated = 0;

  for (const doc of BASE_DOCS) {
    const existing = await LegalDocument.findOne({
      documentType: doc.documentType,
      version,
      locale: 'vi',
    });
    if (existing) {
      // Same version, revised wording (Quy chế 2.1): refresh the text in place so readers and the
      // acceptance flow show the current copy. Version/effective date/acceptances are untouched.
      if (existing.content !== doc.content || existing.title !== doc.title || existing.summary !== doc.summary) {
        existing.title = doc.title;
        existing.summary = doc.summary;
        existing.content = doc.content;
        await existing.save();
        updated += 1;
      } else {
        skipped += 1;
      }
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

  return { created, updated, skipped, version, types: LEGAL_DOCUMENT_TYPES };
}

module.exports = { ensureLegalDocuments, BASE_DOCS };
