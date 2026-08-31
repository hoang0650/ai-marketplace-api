# PH AI Market API

Express + MongoDB backend for [`ai-marketplace`](../ai-marketplace) (PH AI Market).

## Stack

- Node.js 18+
- Express 4
- MongoDB + Mongoose 8
- JWT auth (`Authorization: Bearer <token>`)
- Production hardening: `helmet`, `compression`, per-IP rate limiting (`express-rate-limit`), Mongo operator sanitization (`express-mongo-sanitize`)
- Optional Redis cache (`ioredis`) — read-through cache cho products/creators với fail-fast + circuit breaker; app chạy bình thường khi không có Redis

## Production checklist

- `NODE_ENV=production` — server **refuses to boot** without a strong `JWT_SECRET` (>= 24 chars) and explicit `MDB_CONNECT`.
- `TRUST_PROXY=1` khi chạy sau Render/NGINX/Cloudflare (tự bật khi `NODE_ENV=production`).
- Rate limits: 300 req/min/IP toàn API, 20 req/15min/IP cho `/auth/login|register` (tùy chỉnh qua `RATE_LIMIT_*`).
- Health probes: `GET /health` (liveness), `GET /health/ready` (MongoDB readiness — trả 503 khi DB chưa sẵn sàng).
- Graceful shutdown: SIGTERM/SIGINT → đóng HTTP server rồi đóng MongoDB, force-exit sau 10s.
- Wallet: withdraw kiểm tra số dư ledger, mọi giao dịch cap 100.000 USD, amount làm tròn 2 số thập phân.
- Search sản phẩm escape regex (chống ReDoS), listing mặc định limit 100 (max 200, hỗ trợ `limit`/`offset`).
- Redis (optional): bật qua `REDIS_URL` hoặc `REDIS_ENABLED=true` + `REDIS_HOST`. Command timeout 250ms, circuit breaker mở 30s sau 3 lỗi liên tiếp — Redis chết thì mọi request fallback thẳng MongoDB, không bao giờ treo. Cache: `GET /products` (60s), `GET /products/:slug`, `GET /creators*` (300s); tự invalidate khi create/update/delete/checkout. Xóa key bằng SCAN, không dùng KEYS.

## Quick start

```bash
cd ai-marketplace-api
cp .env.example .env
npm install
# MongoDB: local (mongod) hoặc Atlas — đặt MDB_CONNECT trong .env
# Ví dụ Atlas (DB riêng, không dùng chung Nest):
# MDB_CONNECT=mongodb+srv://USER:PASS@cluster0.xxx.mongodb.net/ai_marketplace?retryWrites=true&w=majority
npm run seed
npm run dev
```

API base: `http://localhost:4100/v1`  
Gateway v2: `http://localhost:4100/v2`  
Health: `http://localhost:4100/health` · Readiness: `http://localhost:4100/health/ready`

## Seed accounts (password: `password`)

| Email | Role |
|-------|------|
| `admin@phaimarket.com` | admin |
| `nova@creators.dev` | creator |
| `orbit@creators.dev` | creator |
| `pulse@creators.dev` | creator |
| `buyer@example.com` | buyer |

## Frontend

Point Angular env to this API and disable mock interceptor:

```ts
// environment.ts
apiUrl: 'http://localhost:4100/v1',
useMockApi: false,
```

## Routes (match mock interceptor)

| Method | Path | Auth |
|--------|------|------|
| POST | `/auth/register` | — |
| POST | `/auth/login` | — |
| GET | `/auth/me` | JWT |
| GET | `/products` | — |
| GET | `/products/:slug` | — |
| POST/PUT/DELETE | `/products` | creator/admin |
| GET | `/categories` | — |
| GET | `/creators`, `/creators/:slug` | — |
| GET/POST | `/reviews` | POST needs JWT |
| GET/POST | `/wishlist`, `/wishlist/toggle` | JWT |
| GET | `/orders`, `/usage`, `/dashboard/summary` | JWT |
| GET/POST | `/wallet`, `/wallet/withdraw` | JWT |
| GET | `/affiliate` | JWT |
| GET/POST | `/notifications`, `/notifications/read-all` | JWT |
| POST | `/billing/checkout` | JWT |
| POST | `/playground/run` | JWT — proxies AI via `denglish-api` (`DENGLISH_API_URL`), records `UsageEvent` + wallet debit |
| POST | `/agents/chat` | JWT — hire-agent chat with persistent memory (`/v1/agent/turn`), wallet + `UsageEvent` |
| POST | `/openclaw/ssh/generate` | JWT — temporary SSH desktop→server (60 min) |
| GET | `/openclaw/ssh/active` | JWT — active SSH session |
| POST | `/openclaw/ssh/revoke` | JWT — revoke SSH |
| POST | `/wallet/deposit` | JWT — buyer nạp tiền |
| POST | `/deployments` | JWT **seller** — deploy product với RunPod runtime (serverless, tokenize, gateway, public endpoint, .env, skills); `syncProduct` mặc định ghi lại `Product.runtime` |
| GET | `/deployments/mine` | JWT seller — deployments của tôi (kèm API key + env) |
| GET | `/deployments/browser` | — Agent Browser công khai (không lộ .env) |
| PATCH/DELETE | `/deployments/:id` | JWT seller — start/stop/publish + cập nhật runtime; `syncProduct: true` để sync về Product |
| POST | `/deployments/:id/invoke` | JWT — chạy + đo token, trừ ví buyer, cộng ví seller (phí sàn 20%) |
| GET | `/deployments/:id/usage` | JWT seller — lịch sử usage + tổng |
| GET/POST | `/servers` | JWT creator — GPU pods (RunPod via denglish-api). Không lộ API key / SSH |
| POST | `/terminal/sessions` | JWT — tạo web terminal session |
| WS | `/ws/terminal/:sessionId?access_token=` | JWT — PTY input/output (xterm protocol JSON) |
| POST | `/game-sessions` | JWT — live game/desktop stream từ pod (host RunPod chỉ nằm trên Node) |
| GET | `/game-sessions/:id/player` | JWT query token — player HTML; sandbox canvas hoặc iframe noVNC/HLS qua reverse-proxy |
| ALL | `/game-sessions/:id/proxy/*` | JWT + cookie — HTTP/WS tới public port pod, không lộ IP |
| GET | `/providers` | — provider registry (capabilities; Python-first, Node fallback) |
| POST | `/api-keys` | JWT — mint `mk_live_` key (hash only in DB) |
| POST | `/v1/chat/completions` | JWT or marketplace key — OpenAI-compatible gateway |
| GET | `/agent-templates` | — generic agent runtime templates |
| GET/POST | `/training-jobs` | JWT — training jobs via provider adapter |
| POST | `/edge/infer/:slug` | JWT — inference qua cạnh ProxVN / API bán, trừ ví |

**Seller docs:** [docs/SELLER-API-USAGE.md](./docs/SELLER-API-USAGE.md) — API Gateway, đếm token cho buyer, checklist seller.  
**GPU/Game streaming:** [docs/SELLER-COMPUTE-STREAMING.md](./docs/SELLER-COMPUTE-STREAMING.md) — webhook, proxy stream, billing theo phiên.

### Product / Deployment `runtime`

| Field | Ý nghĩa |
|-------|---------|
| `serverlessEndpoint` | RunPod serverless URL (`…/runsync`) |
| `publicEndpoint` | Public RunPod / proxy URL |
| `tokenizeEndpoint` | Endpoint đếm token (meter) |
| `gatewayUrl` | Gateway (HTTP/WSS) |
| `env` | Mảng `{key,value}` hoặc chuỗi `.env` khi tạo |
| `skills` | Skill packs gắn runtime |
| `baseModel` / `systemPrompt` / `temperature` / `maxTokens` | Inference defaults |
