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

Trên sản phẩm model/API, chọn **Usage-based**. `usageRate` là giá của **một** `usageUnit` đã chọn (mặc định USD; VND hoặc CNY được đổi sang USD theo tỷ giá lấy từ ExchangeRate-API, https://www.exchangerate-api.com, trước khi trừ ví). Không mặc định “USD / 1K tokens”. Alias lúc ghi là `unit` và `rate`, lưu thành `usageUnit` và `usageRate`. `computeUsageCost()` tính theo hợp đồng mục 9 (`exact_pro_rata_round6`), không chỉ theo token.

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
A: Có. Mỗi response có `usage`; buyer xem lịch sử + tổng ở trang `/usage` hoặc qua `GET /v1/usage/me?limit=100` (tối đa 200 dòng gần nhất). Response: `{ currency, summary: { requests, totalCharged, totalInputTokens, totalOutputTokens, totalTokens }, items }` — gồm `UsageEvent` (API/GPU) và các lần trừ ví agent OpenClaw / Hermes / NanoClaw.

**Q: Deployment invoke khác gì gateway?**  
A: `POST /deployments/:id/invoke` có thể nhận token client báo cáo — ưu tiên gateway cho billing chính xác.

---

## 9. Hợp đồng tính tiền (pricing units)

Seller đặt giá trên `pricing` của sản phẩm `model: "usage"`. Trường lưu là `usageUnit` và `usageRate`. Khi tạo hoặc sửa, có thể gửi alias `unit` và `rate`; server đổi về mã cố định. Sản phẩm cũ với `usageUnit` dạng `"tokens"` (mỗi 1M token), `"hour"`, `"phút"` hoặc `"GPU hour"` vẫn tính đúng, không cần migration.

### 9.1. Trường giá

```json
{
  "model": "usage",
  "currency": "USD",
  "usageUnit": "1k_tokens",
  "usageRate": 0.5,
  "inputRate": 0.4,
  "outputRate": 1.2,
  "cachedInputRate": 0.1,
  "minCharge": 0.01
}
```

| Trường | Ý nghĩa |
|--------|---------|
| `usageUnit` | Mã đơn vị. Alias lúc ghi: `token`, `1k_tokens`, `1m_tokens`, `1k_chars`, `1m_chars`, `second`, `minute`, `hour`, `request`, `image` |
| `usageRate` | Đơn giá cho **một** đơn vị, theo `currency` |
| `inputRate` | Tuỳ chọn. Token input chưa cache, cùng cỡ đơn vị với `usageRate`. Thiếu thì dùng `usageRate` |
| `outputRate` | Tuỳ chọn. Token output. Thiếu thì dùng `usageRate` |
| `cachedInputRate` | Tuỳ chọn. Token input đã cache. Thiếu thì bằng giá input. `0` nghĩa là cache miễn phí |
| `minCharge` | Tuỳ chọn. Sàn tiền (cùng `currency`) chỉ khi lượt gọi thành công và tiền đo được > 0 nhưng nhỏ hơn sàn |
| `currency` | `USD` (mặc định), `VND`, hoặc `CNY`. Ví trừ bằng USD |

Mã lưu và cỡ đơn vị:

| `usageUnit` | Đếm gì | Một đơn giá mua |
|-------------|---------|-----------------|
| `1_token` | token | 1 token |
| `1k_tokens` | token | 1 000 token |
| `1m_tokens` | token | 1 000 000 token |
| `1k_characters` | ký tự Unicode | 1 000 ký tự |
| `1m_characters` | ký tự Unicode | 1 000 000 ký tự |
| `1_second` | giây | 1 giây |
| `1_minute` | giây | 60 giây |
| `1_hour` | giây | 3 600 giây |
| `1_request` | request thành công | 1 request |
| `1_image` | ảnh | 1 ảnh |

`GET /v1/usage/units` trả `units`, `allowedByCategory`, `rounding`, `measurement`, `sellerReportBounds`.

Catalog và chi tiết sản phẩm thêm `pricing.meter`:

```json
{
  "unit": "1k_tokens",
  "rate": 0.5,
  "currency": "USD",
  "inputRate": 0.4,
  "outputRate": 1.2,
  "cachedInputRate": 0.1,
  "minCharge": 0.01,
  "rounding": "exact_pro_rata_round6"
}
```

### 9.2. Cách đếm

`quantity` trong lịch sử buyer là **số thô** (token, ký tự, giây, ảnh, request), không phải số đơn vị đã chia.

- **Ký tự.** Số code point Unicode NFC của văn bản request. Thứ tự field: `messages[].content` (nối bằng xuống dòng), rồi `prompt`, rồi `text`, rồi `input` nếu là string. `Tiếng Việt` = 10, emoji = 1.
- **Token.** `prompt_tokens` hoặc `input_tokens`, cộng `completion_tokens` hoặc `output_tokens`. Thiếu cả hai thì `ceil(số ký tự / 4)` cho input và cho output.
- **Token cache.** Lấy số dương đầu tiên trong `prompt_tokens_details.cached_tokens`, `input_tokens_details.cached_tokens`, `cache_read_input_tokens`, `cached_input_tokens`, `cached_tokens`. Provider kiểu OpenAI đã tính cache **nằm trong** prompt: gateway trừ khỏi input rồi tính `cachedInputRate`. Không cộng thêm vào tổng. Nếu cache lớn hơn prompt thì kẹp bằng prompt.
- **Ảnh.** `output.images[]`, hoặc `output.data[]` có `url` / `b64_json` / `image_url`, hoặc 1 ảnh khi có `output.image_url` / `imageUrl` / `kind: "image"`.
- **Request.** 1 nếu HTTP 2xx. `0` nếu không phải 2xx, `usage.ok === false`, hoặc `usage.billable === false`.
- **Thời gian (gateway).** `duration_seconds` / `durationSec` / `billed_seconds` trên output hoặc usage. `gpu-compute`, `game-server`, `training-service` không có số đó thì dùng đồng hồ tường của gateway (ms / 1000).

Buyer gửi `quantity`, `duration`, hoặc `usage` trên request thì **không** được tính.

### 9.3. Làm tròn

`exact_pro_rata_round6`:

```
tiền USD = làm_tròn_nửa_lên_6_chữ_số( (quantity / cỡ_đơn_vị) × đơn_giá_USD )
```

- Giây: đúng số giây, kể cả phần lẻ (`1.5` giây × `$0.02` = `$0.03`).
- Phút và giờ: **pro-rata**, không làm tròn lên cả phút/giờ. `90` giây ở `$0.60/phút` = `$0.90`, không phải `$1.20`.
- Đơn vị nhỏ nhất của ví cho usage là `$0.000001` (half-up). `$0.0000005` → `$0.000001`; `$0.0000004` → `$0`.
- Phí sàn: **20%** giá trị đơn (`PLATFORM_COMMISSION_RATE`) sau giảm giá, qua cùng settlement với checkout. Buyer trả từ ví; seller nhận phần còn lại trên sổ phải trả. Self-use (buyer là seller) không trừ ví.
- Phiên GPU/game stream là sổ riêng, không dùng `exact_pro_rata_round6` và không áp `minCharge`. Worker (`GAME_BILLING_TICK_MS`, mặc định 60 giây) trừ theo **phút nguyên**, theo cent: lúc chạy làm tròn xuống và cộng dồn phần lẻ dưới 1 cent; lúc dừng, phút lẻ cuối làm tròn lên (tối thiểu 1 phút nếu phiên đã chạy) và phần cent còn lại làm tròn lên. `ratePerHour` và `billedCost` là USD. `currency` trên heartbeat là `pricing.currency` của listing (USD, VND hoặc CNY), không phải đơn vị của số tiền đã trừ. Trước khi start, số dư khả dụng (USD) phải ≥ `max(ratePerHour / 60, 0.01)`; thiếu thì 402 `INSUFFICIENT_BALANCE` hoặc `PAYOUT_HELD`. Một request gateway trên cùng category vẫn pro-rata như các gạch đầu dòng phía trên.

### 9.4. Seller runtime báo usage

Gateway chỉ tin usage trên **response của chính sản phẩm đó**, trong giới hạn:

| Chiều | Trần một request thành công |
|-------|------------------------------|
| token | 2 000 000 |
| ký tự | 2 000 000 |
| ảnh | 32 |
| request | 1 |
| giây | `min(6 giờ, max(2 × thời gian tường, 1 giây))` khi gateway biết wall clock; nếu không thì 6 giờ |

Vượt trần, sai chiều, hoặc `quantity` / tổng token bằng 0 thì bỏ report và đo phía server như mục 9.2. Report `0` không xoá số đếm mà gateway đã thấy. Muốn không tính tiền thì trả HTTP không phải 2xx, `usage.ok: false`, hoặc `usage.billable: false`. Runtime phải tự ghi `usage`, không copy nguyên body của buyer.

**Cách 1 — usage OpenAI** (token, cache):

```json
{
  "usage": {
    "prompt_tokens": 1000,
    "completion_tokens": 200,
    "prompt_tokens_details": { "cached_tokens": 800 }
  }
}
```

Input tính tiền = 200. Cache = 800. Output = 200.

**Cách 2 — `usage.report`** (hoặc `usage.aim`, `usage.seller_report`):

```json
{
  "usage": {
    "report": { "unit": "image", "quantity": 2 }
  }
}
```

Token tách input/output/cache (số thô, không phải số đơn vị giá):

```json
{
  "usage": {
    "report": { "unit": "1k_tokens", "input": 1000, "output": 200, "cached": 800 }
  }
}
```

`{ "unit": "token", "quantity": 1500 }` không có `input`/`output` thì cả 1500 token tính theo `usageRate` (không dùng giá tách).

**Cách 3 — header** `X-AIM-Usage` (JSON). Gateway đọc khi response đưa header vào `usage["x-aim-usage"]` hoặc `headers["x-aim-usage"]`:

```
X-AIM-Usage: {"unit":"second","quantity":12}
```

`unit` nhận alias ở mục 9.1 hoặc mã cố định. `quantity` là số thô.

HTTP không phải 2xx thì không trừ ví, kể cả khi body có `usage`.

### 9.5. Ví dụ tiền

Đơn giá USD, chưa sàn `minCharge`.

| Đơn vị | Số đo | Giá | Tiền |
|--------|-------|-----|------|
| `1_token` | 1 000 in + 100 out | in `$0.000003`, out `$0.000015` | `$0.0045` |
| `1k_tokens` | 2 000 token | `$0.50` | `$1.00` |
| `1m_tokens` | prompt 1 000 (800 cache), out 200 | in `$3`, cache `$0.30`, out `$15` | `(200×3 + 800×0.30 + 200×15) / 1e6 = $0.00384` |
| `1k_characters` | `abcd` = 4 ký tự | `$1` | `$0.004` |
| `1m_characters` | 2 500 ký tự | `$2` | `$0.005` |
| `1_second` | 1.5 giây | `$0.02` | `$0.03` |
| `1_minute` | 90 giây | `$0.60` | `$0.90` |
| `1_hour` | 90 giây | `$1.20` | `$0.03` |
| `1_request` | 1 request 200 | `$0.02` | `$0.02` |
| `1_image` | 3 ảnh | `$0.04` | `$0.12` |

`GET /v1/usage/me` mỗi dòng có `quantity`, `unit`, `rate`, `rateCurrency`, `inputRate`, `outputRate`, `cachedInputRate`, `amount` (USD đã trừ), `currency`.

---

## 10. Liên hệ

- Support: support@aimarkets.vn  
- Frontend seller docs: `/sell/docs/api-usage`  
- Dashboard usage: `/dashboard/usage`
