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

API base: `http://localhost:4100/api`  
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
apiUrl: 'http://localhost:4100/api',
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
| POST | `/openclaw/ssh/generate` | JWT — temporary SSH desktop→server (60 min) |
| GET | `/openclaw/ssh/active` | JWT — active SSH session |
| POST | `/openclaw/ssh/revoke` | JWT — revoke SSH |
| POST | `/wallet/deposit` | JWT — buyer nạp tiền |
