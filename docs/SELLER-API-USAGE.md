# Hướng dẫn Seller — API Gateway & đếm token

Tài liệu này giải thích cách **người mua (buyer)** trên AI Markets đếm token khi gọi sản phẩm AI của bạn, và **seller cần cấu hình gì** để billing hoạt động đúng.

---

## 1. Nguyên tắc quan trọng

| Cách buyer gọi API | Ai đếm được token theo từng user? |
|---------------------|-----------------------------------|
| Gọi **trực tiếp** Featherless / OpenRouter / RunPod bằng key của bạn | **Không** — dashboard provider chỉ có tổng theo key tài khoản seller |
| Gọi qua **AI Markets Gateway** (`api.aimarkets.vn/v1/...`) | **Có** — mỗi request ghi `UsageEvent` theo `buyer` |

**Seller không nên** đưa API key nhà cung cấp cho buyer. Buyer dùng:

- JWT đăng nhập (playground, app nội bộ), hoặc
- **Marketplace API key** dạng `mk_live_...` (tích hợp OpenAI-compatible)

Backend proxy inference qua `denglish-api`, lấy `usage` từ response provider, rồi ghi billing.

---

## 2. Luồng cho buyer

```
Buyer (JWT hoặc mk_live_ key)
  → POST https://api.aimarkets.vn/v1/chat/completions
  → ai-marketplace-api (meter + trừ ví)
  → denglish-api /v1/infer
  → Provider (Featherless, OpenRouter, RunPod, …)
  ← usage { input_tokens, output_tokens }
  → UsageEvent (audit) + UsageStat (seller theo ngày) + WalletTx
```

Mỗi response trả về:

```json
{
  "usage": {
    "input_tokens": 12,
    "output_tokens": 48,
    "total_tokens": 60
  },
  "marketplace": {
    "cost": 0.0012,
    "provider": "featherless"
  }
}
```

Buyer **đếm token từng request** ngay trong response. Tổng lịch sử (theo ngày / theo sản phẩm) sẽ có qua API usage buyer *(đang bổ sung)*.

---

## 3. Seller cần làm gì

### 3.1. Đặt pricing `usage`

Trên sản phẩm model/API, chọn **Usage-based** và cấu hình `usageRate` (ví dụ USD / 1K tokens). Hệ thống dùng `computeUsageCost()` để tính phí từ token provider trả về.

### 3.2. Product slug = model id

Gateway map `model` trong body request → **slug sản phẩm** (ví dụ `"model": "qwen-2.5-72b-instruct"`).

Buyer với `mk_live_` key chỉ gọi được **đúng một product** đã gắn khi tạo key.

### 3.3. Runtime / provider (phía seller)

Cấu hình `Product.runtime` (hoặc deploy sync):

| Field | Mục đích |
|-------|----------|
| `baseModel` | Model id gửi lên provider |
| `gatewayUrl` | URL inference (white-label, không lộ cho buyer) |
| `env` | Key provider — **chỉ server**, không public |

Provider được resolve tự động: `featherless`, `openrouter`, `runpod_public`, …

### 3.4. Không chia key provider

- Key Featherless/OpenRouter của seller chỉ nằm trong env server / Dokploy.
- Buyer chỉ nhận `mk_live_...` hoặc JWT AI Markets.

---

## 4. API cho buyer (OpenAI-compatible)

**Base URL:** `https://api.aimarkets.vn/v1`

| Method | Path | Auth |
|--------|------|------|
| GET | `/models` | JWT hoặc `Bearer mk_live_...` |
| POST | `/chat/completions` | JWT hoặc `Bearer mk_live_...` |
| POST | `/embeddings` | JWT hoặc `Bearer mk_live_...` |
| POST | `/playground/run` | JWT (UI playground) |
| POST | `/edge/infer/:slug` | JWT (ProxVN / public edge) |

### Tạo API key (buyer)

```http
POST /v1/api-keys
Authorization: Bearer <buyer_jwt>
Content-Type: application/json

{ "productSlug": "your-product-slug", "name": "production" }
```

Response trả `apiKey` **một lần** — lưu ngay, server chỉ giữ hash.

### Gọi chat completions

```bash
curl https://api.aimarkets.vn/v1/chat/completions \
  -H "Authorization: Bearer mk_live_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-product-slug",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 256
  }'
```

**Lỗi thường gặp**

| HTTP | Ý nghĩa |
|------|---------|
| 402 | Ví buyer không đủ — cần nạp tiền |
| 403 | API key không thuộc product này |
| 400 | Thiếu `model` (slug) |

---

## 5. Seller xem usage & doanh thu

| Endpoint | Role | Mô tả |
|----------|------|--------|
| `GET /v1/usage` | creator, admin | Token / requests / revenue **theo ngày** (seller) |
| `GET /v1/dashboard/summary` | creator | Tổng quan tokenUsage |
| `GET /v1/deployments/:id/usage` | seller | Usage theo deployment |

Dữ liệu nguồn: collection `UsageEvent` (từng lần gọi) và `UsageStat` (rollup ngày).

**Phí sàn:** 20% (`PLATFORM_FEE_RATE`) — seller nhận net sau phí.

**Self-use:** Seller tự gọi sản phẩm của mình (`buyer === seller`) — không trừ ví, không ghi cost *(dùng để test)*.

---

## 6. Checklist trước khi bán API usage

- [ ] Sản phẩm published, slug rõ ràng
- [ ] `pricing.model = usage`, `usageRate` đã set
- [ ] Runtime trỏ đúng provider/model
- [ ] Provider key cấu hình trên server (Dokploy), không embed frontend
- [ ] Buyer có hướng dẫn tạo `mk_live_` key và gọi `/v1/chat/completions`
- [ ] Trang mô tả sản phẩm ghi rõ endpoint: `https://api.aimarkets.vn/v1`

---

## 7. FAQ

**Q: Buyer hỏi sao dashboard Featherless của tôi không tách được user?**  
A: Dashboard provider là tài khoản seller. Per-user chỉ có khi gọi qua AI Markets gateway.

**Q: Token lấy từ đâu?**  
A: Từ `usage` response provider (qua denglish-api). Không tự đoán trừ sandbox mode.

**Q: Buyer có xem tổng token đã dùng không?**  
A: Mỗi response có `usage`. API tổng theo buyer đang được bổ sung (`GET /v1/usage/me`).

**Q: Deployment invoke khác gì gateway?**  
A: `POST /deployments/:id/invoke` có thể nhận token client báo cáo — ưu tiên gateway cho billing chính xác.

---

## 8. Liên hệ

- Support: support@aimarkets.vn  
- Frontend seller docs: `/sell/docs/api-usage`  
- Dashboard usage: `/dashboard/usage`
