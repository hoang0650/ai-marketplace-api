const LegalDocument = require('../models/LegalDocument');
const { LEGAL_DOCUMENT_TYPES } = LegalDocument;

const PLATFORM_NAME = 'AI Markets (aimarkets.vn)';
const OPERATOR = 'PHGROUP / đơn vị vận hành AI Markets';

const BASE_DOCS = [
  {
    documentType: 'terms',
    title: 'Điều khoản sử dụng AI Markets',
    summary: 'Điều khoản chung cho Buyer và người dùng nền tảng.',
    content: `# Điều khoản sử dụng

${PLATFORM_NAME} vận hành theo mô hình sàn TMĐT trung gian + bán hàng trực tiếp (Platform Direct).
Người dùng đồng ý với Quy chế sàn, chính sách thanh toán/hoàn tiền/tranh chấp phiên bản hiện hành.`,
  },
  {
    documentType: 'privacy',
    title: 'Chính sách bảo mật AI Markets',
    summary: 'Bảo vệ dữ liệu cá nhân theo pháp luật Việt Nam.',
    content: `# Chính sách bảo mật

Xử lý dữ liệu cá nhân phục vụ tài khoản, đơn hàng, xác minh Seller và audit.
Chi tiết bổ sung có thể xem trên trang Privacy của nền tảng.`,
  },
  {
    documentType: 'marketplace-rules',
    title: 'Quy chế sàn thương mại điện tử trung gian AI Markets',
    summary: 'Quy chế hoạt động sàn TMĐT trung gian theo pháp luật Việt Nam.',
    content: `# Quy chế sàn thương mại điện tử trung gian

## 1. Vai trò nền tảng
${PLATFORM_NAME} do ${OPERATOR} vận hành theo mô hình **sàn thương mại điện tử trung gian** khi có bên thứ ba đăng bán, đồng thời có thể bán trực tiếp sản phẩm/dịch vụ của nền tảng (**Platform Direct**).

## 2. Phân biệt chủ thể
- **Buyer**: người mua / sử dụng dịch vụ.
- **Seller**: bên thứ ba cung cấp sản phẩm/dịch vụ trên sàn (sau khi xác minh).
- **Platform**: đơn vị vận hành sàn; có thể là người bán trực tiếp khi \`ownershipType = PLATFORM_DIRECT\`.
- **Provider**: hạ tầng kỹ thuật (RunPod, OpenRouter, AWS, …) — **không** đồng nghĩa Seller.

## 3. Điều kiện đăng bán
Seller phải hoàn tất xác minh danh tính/doanh nghiệp, chấp thuận Thỏa thuận Seller và tuân thủ kiểm duyệt sản phẩm trước khi công khai listing.

## 4. Nghĩa vụ trung gian
Sàn cung cấp listing, đặt hàng, ghi nhận hợp đồng/order, tích hợp thanh toán, đo lường usage, xử lý khiếu nại/tranh chấp và lưu trữ hồ sơ theo quy định pháp luật.

## 5. Cấm giao dịch ngoài sàn
Các bên không được yêu cầu thanh toán ngoài hệ thống cho giao dịch phát sinh trên sàn.

## 6. Phí
Phí sàn (commission, mặc định 20% third-party) tách khỏi phí cửa hàng Google Play / App Store khi thanh toán IAP. Phí cửa hàng do Google/Apple thu, không phải doanh thu sàn.

## 7. Luật áp dụng
Pháp luật Việt Nam; Nghị định về thương mại điện tử và bảo vệ dữ liệu cá nhân áp dụng khi có hiệu lực.`,
  },
  {
    documentType: 'seller-policy',
    title: 'Chính sách người bán (Seller Policy)',
    summary: 'Điều kiện, nghĩa vụ và quyền của Seller trên sàn trung gian.',
    content: `# Chính sách người bán

## Điều kiện
- Tài khoản hợp lệ; hồ sơ Seller đầy đủ; trạng thái xác minh **VERIFIED**.
- Chấp thuận Thỏa thuận Seller (phiên bản hiện hành).

## Nghĩa vụ
- Cung cấp thông tin sản phẩm trung thực; sở hữu/quyền cấp phép hợp pháp.
- Không bán hàng cấm, nội dung bất hợp pháp, hoặc giả mạo Platform Direct.
- Chịu trách nhiệm về chất lượng dịch vụ bên thứ ba cung cấp.

## Hoa hồng sàn (platform commission)
Phí sàn mặc định **20%** trên giá trị giao dịch third-party, **không phải thuế seller**.
Khách hàng thanh toán giá niêm yết; Seller chịu phí sàn trừ khi có rule khác.
Sản phẩm **Platform Direct** không chia 80/20 — toàn bộ doanh thu thuộc nền tảng (sau phí cửa hàng nếu có IAP).
Mọi order lưu **snapshot** commissionRate / commissionAmount tại thời điểm giao dịch.

## Phí Google Play (CHPlay) và App Store
Khi Buyer thanh toán bằng In-App Purchase:
- **Google Play / CHPlay**: phí dịch vụ cửa hàng mặc định **15%** (Google có thể áp 15% hoặc 30% theo điều khoản Google tại thời điểm giao dịch).
- **App Store**: hoa hồng Apple mặc định **30%** (có thể 15% theo Apple Small Business Program hoặc subscription năm 2+).
Phí cửa hàng do Google/Apple thu, **không phải phí sàn**, **không phải thuế**, **không phải doanh thu AI Markets**. Sàn khấu trừ theo snapshot để tính seller net / payout vì số tiền thực nhận đã bị cửa hàng cắt.
Giao dịch web / ví aimarkets.vn: phí CHPlay/App Store = 0.

## Hoa hồng / entitlement
Doanh thu Seller là **entitlement đối soát** trên ledger nội bộ, không phải số dư ví điện tử được cấp phép trừ khi có giấy phép phù hợp.`,
  },
  {
    documentType: 'seller-agreement',
    title: 'Thỏa thuận Seller AI Markets',
    summary: 'Hợp đồng tham gia bán hàng trên sàn trung gian.',
    content: `# Thỏa thuận Seller

Bằng việc chấp thuận, Seller đồng ý:
1. Tuân thủ Quy chế sàn và pháp luật Việt Nam về TMĐT trung gian.
2. Cung cấp giấy tờ xác minh trung thực.
3. Không dùng Provider hạ tầng làm danh tính Seller.
4. Chấp nhận kiểm duyệt sản phẩm, tạm ngưng, gỡ listing khi vi phạm.
5. Thanh toán/đối soát qua kênh được sàn chỉ định; không thu tiền ngoài sàn cho đơn trên sàn.
6. Chịu phí sàn (mặc định 20%) và phí cửa hàng Google Play / App Store khi giao dịch IAP, theo snapshot đơn.
7. Chịu trách nhiệm pháp lý đối với sản phẩm THIRD_PARTY_SELLER của mình.`,
  },
  {
    documentType: 'buyer-policy',
    title: 'Chính sách người mua (Buyer Policy)',
    summary: 'Quyền và nghĩa vụ Buyer trên AI Markets.',
    content: `# Chính sách người mua

- Kiểm tra nhãn **Bán bởi sàn** (Platform Direct) hoặc **Bán bởi Seller** trước khi đặt hàng.
- Thanh toán qua cổng/phương thức được sàn hỗ trợ.
- Khiếu nại/tranh chấp theo Dispute Policy trong thời hạn quy định.`,
  },
  {
    documentType: 'payment-policy',
    title: 'Chính sách thanh toán',
    summary: 'Thanh toán qua cổng trung gian; ledger nội bộ chỉ để đối soát.',
    content: `# Chính sách thanh toán

## Nguyên tắc
Sàn **không** tự vận hành ví điện tử / nhận tiền gửi không kỳ hạn nếu chưa có giấy phép phù hợp.

## Luồng chuẩn
Buyer → Cổng thanh toán được cấp phép / phương thức được phép → Xác nhận Order → Ledger nội bộ (entitlement, phí sàn, chi phí provider).

## Ledger
Số dư hiển thị (nếu có) là **quyền lợi đối soát nội bộ**, không phải tiền gửi ngân hàng.

## Phí sàn 20%
Platform commission được ghi **PLATFORM_REVENUE**, tách khỏi thuế khấu trừ (**TAX_PAYABLE**) và seller payable.
Không đồng nhất “còn 80%” với nghĩa vụ thuế.

## Phí CHPlay / App Store (IAP)
Thanh toán In-App Purchase qua Google Play hoặc App Store chịu phí cửa hàng do Google/Apple thu (mặc định snapshot **15% CHPlay**, **30% App Store**). Ghi **STORE_FEE**, không ghi vào doanh thu sàn. Seller net = gộp − phí sàn − phí cửa hàng − thuế − phí thanh toán − hoàn/chargeback.`,
  },
  {
    documentType: 'refund-policy',
    title: 'Chính sách hoàn tiền',
    summary: 'Hoàn tiền theo loại sản phẩm và quyết định tranh chấp.',
    content: `# Chính sách hoàn tiền

Hoàn tiền có thể áp dụng khi: lỗi kỹ thuật phía sàn, sản phẩm không giao được, hoặc quyết định tranh chấp nghiêng về Buyer. Dịch vụ usage/metered đã tiêu thụ có thể không hoàn toàn bộ. Mọi hoàn tiền được ghi vào Refund Ledger.`,
  },
  {
    documentType: 'dispute-policy',
    title: 'Chính sách tranh chấp',
    summary: 'Quy trình tranh chấp Buyer–Seller / Buyer–Platform.',
    content: `# Chính sách tranh chấp

Loại tranh chấp: BUYER_SELLER, BUYER_PLATFORM, SELLER_PLATFORM.
Buyer mở dispute trong cửa sổ hold; sàn xem xét bằng chứng; kết quả có thể hoàn tiền, giữ entitlement Seller, hoặc hòa giải. Quyết định được audit log.`,
  },
  {
    documentType: 'complaint-policy',
    title: 'Chính sách khiếu nại',
    summary: 'Tiếp nhận và xử lý khiếu nại trên sàn.',
    content: `# Chính sách khiếu nại

Gửi khiếu nại qua kênh hỗ trợ / form trên sàn. Sàn ghi nhận, phân loại, phản hồi trong thời hạn hợp lý và lưu hồ sơ phục vụ cơ quan nhà nước khi có yêu cầu hợp pháp.`,
  },
  {
    documentType: 'intellectual-property',
    title: 'Chính sách sở hữu trí tuệ',
    summary: 'Bảo vệ IP và gỡ nội dung xâm phạm.',
    content: `# Sở hữu trí tuệ

Seller cam kết có quyền phân phối model/dataset/agent/API. Thông báo xâm phạm IP được xử lý theo quy trình notice-and-takedown của sàn.`,
  },
  {
    documentType: 'acceptable-use',
    title: 'Chính sách sử dụng chấp nhận được (AUP)',
    summary: 'Cấm lạm dụng AI, phá hoại, nội dung bất hợp pháp.',
    content: `# Acceptable Use

Cấm: malware, tấn công hạ tầng, nội dung bất hợp pháp theo pháp luật Việt Nam, deepfake độc hại, thu thập dữ liệu trái phép, đào tạo trên dữ liệu không có quyền.`,
  },
  {
    documentType: 'data-policy',
    title: 'Chính sách dữ liệu',
    summary: 'Xử lý dữ liệu cá nhân và dữ liệu giao dịch sàn.',
    content: `# Chính sách dữ liệu

Tuân thủ pháp luật bảo vệ dữ liệu cá nhân Việt Nam. Dữ liệu đơn hàng, xác minh Seller, audit được lưu theo thời hạn phục vụ đối soát và yêu cầu cơ quan có thẩm quyền.`,
  },
  {
    documentType: 'tax-policy',
    title: 'Chính sách thuế AI Markets',
    summary: 'Phí sàn 20% không phải thuế; khấu trừ và kê khai theo hồ sơ Seller và Tax Engine.',
    content: `# Chính sách thuế

## Phí sàn không phải thuế
Marketplace thu **platform commission** (mặc định 20% đối với seller bên thứ ba). Đây **không** phải thuế thu nhập / VAT của seller.

## Phí CHPlay / App Store không phải thuế
Phí Google Play (mặc định 15%) và App Store (mặc định 30%) trên IAP là hoa hồng/phí dịch vụ của cửa hàng ứng dụng, **không phải thuế**, không phải phí sàn. Sàn khấu trừ snapshot khi tính payout.

## Nghĩa vụ thuế của Seller
Seller chịu trách nhiệm kê khai, nộp thuế theo loại hình (cá nhân, hộ kinh doanh, doanh nghiệp, seller nước ngoài) và pháp luật áp dụng.

## Khấu trừ
Khi pháp luật / Tax Rule yêu cầu, sàn có thể **khấu trừ** tại nguồn. Tỷ lệ **không** hard-code trong điều khoản vì có thể thay đổi theo pháp luật và hồ sơ thuế đã xác minh.

## Hóa đơn
Hóa đơn sàn (phí dịch vụ marketplace) khác hóa đơn hàng hóa/dịch vụ của Seller tới Buyer khi giao dịch third-party.

## Seller nước ngoài
Không mặc định áp dụng cùng cách tính với seller Việt Nam. Hồ sơ thuế / residency được version hóa.

## Thay đổi
Thay đổi luật hoặc Tax Rule chỉ áp dụng cho giao dịch mới. Order đã snapshot không bị tính lại.`,
  },
  {
    documentType: 'invoice-policy',
    title: 'Chính sách hóa đơn AI Markets',
    summary: 'Phân biệt hóa đơn nền tảng (commission) và hóa đơn seller.',
    content: `# Chính sách hóa đơn

Sàn không giả định mình là bên bán đối với mọi giao dịch.

- **PLATFORM_INVOICE**: phí dịch vụ sàn / commission / hàng Platform Direct.
- **SELLER_INVOICE**: hàng hóa/dịch vụ do seller thứ ba cung cấp cho buyer (khi mô hình pháp lý/accounting yêu cầu).

Chi tiết xuất hóa đơn theo hồ sơ thuế đã xác minh và quy định hóa đơn điện tử đang hiệu lực.`,
  },
];

async function ensureLegalDocuments() {
  const version = '2026.09.08';
  const effectiveAt = new Date('2026-09-08T00:00:00.000Z');
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
