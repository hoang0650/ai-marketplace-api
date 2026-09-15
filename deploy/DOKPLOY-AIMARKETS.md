# Dokploy + Traefik — AI Markets (aimarkets.vn)

VPS Hostinger `72.62.72.165` · Dokploy `deploy.phgrouptechs.com` · DNS **Mắt Bão** (không dùng Hostinger DNS Manager cho `.vn`).

## DNS (Mắt Bão)

| Host | Type | Value |
|------|------|-------|
| `@` | A | IP frontend (Vercel hoặc VPS) |
| `www` | CNAME | Vercel / frontend |
| `api` | A | `72.62.72.165` |
| `ai` | A | `72.62.72.165` |

## API (`aimarketplace-api`)

### Dokploy → Application → Domains

| Domain | Path | Port | HTTPS |
|--------|------|------|-------|
| `api.aimarkets.vn` | `/` | `4100` | Let's Encrypt |

Sau khi DNS propagate: **Refresh certificate** nếu thấy `ENOTFOUND`.

### Environment (Dokploy → Environment)

```env
NODE_ENV=production
PORT=4100
TRUST_PROXY=1
MDB_CONNECT=mongodb+srv://...
JWT_SECRET=<>=24 ký tự>
REFRESH_TOKEN_SECRET=<khác JWT_SECRET, >=24 ký tự>
REDIS_URL=rediss://...
# Bắt buộc có www — Vercel redirect aimarkets.vn → www.aimarkets.vn
CORS_ORIGINS=https://aimarkets.vn,https://www.aimarkets.vn,http://localhost:4200,http://127.0.0.1:4200
GOOGLE_CLIENT_ID=<web-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
AIMARKETS_API_HOST=https://api.aimarkets.vn
AIMARKETS_AI_HOST=https://ai.aimarkets.vn
FRONTEND_URL=https://aimarkets.vn
```

Deploy từ GitHub: `hoang0650/ai-marketplace-api` branch `master`.

### Google OAuth (bắt buộc trên Cloud Console)

Popup GIS trên `aimarkets.vn` bị **Error 400: origin_mismatch** nếu client ID đang gắn origin của PHHotel. AI Markets dùng **redirect server-side** (giống đổi code + `GOOGLE_CLIENT_SECRET` của phhotel-api), nên Google chỉ kiểm tra **Authorized redirect URIs**, không kiểm tra JS origin của frontend.

Trong [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → OAuth 2.0 Client ID (Web):

| Field | Values |
|-------|--------|
| Authorized redirect URIs | `https://api.aimarkets.vn/v1/auth/google/callback` |
| | `http://localhost:4100/v1/auth/google/callback` (dev) |

Nếu tạo **client riêng** cho AI Markets (khuyên dùng, đừng share client PHHotel): Authorized JavaScript origins có thể để trống. `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` trên Dokploy phải khớp client đó.

Luồng: `aimarkets.vn` → `GET /v1/auth/google/start` → Google → `GET /v1/auth/google/callback` → `/auth/google/callback?token=`.

### Kiểm tra

```bash
curl -s https://api.aimarkets.vn/health
curl -s "https://api.aimarkets.vn/v1/products?limit=1"
```

## Traefik (Dokploy → Traefik File System)

1. **`traefik.yml`** — giữ `openclaw/deploy/dokploy-traefik.yml` (HTTP→HTTPS + Let's Encrypt HTTP-01).
2. **`dynamic/middlewares.yml`** — `openclaw/deploy/dokploy-dynamic-middlewares.yml`.
3. **`dynamic/aimarkets.yml`** — `ai-marketplace-api/deploy/dokploy-dynamic-aimarkets.yml` (CORS/security headers).

**GPU Play iframe:** `aimarkets.vn` nhúng `https://api.aimarkets.vn/v1/game-sessions/:id/player`. Middleware `aimarkets-security` **không** được `frameDeny: true` (Chrome hiện “đã từ chối kết nối”). Nếu gắn middleware trên Domain trong Dokploy UI, tắt **X-Frame-Options DENY**.

Reload Traefik sau khi save (Dokploy thường auto-reload).

## Frontend (Angular)

Deploy `hoang0650/ai-marketplace` lên Vercel hoặc Dokploy:

- `environment.prod.ts`: `apiUrl: https://api.aimarkets.vn/v1`
- Domain: `www.aimarkets.vn` / `aimarkets.vn`

## SSH (tuỳ chọn)

```bash
ssh root@72.62.72.165
docker ps | grep -i traefik
docker ps | grep -i aimarket
ls /etc/dokploy/traefik/dynamic/
```

Không thêm `aimarkets.vn` vào Hostinger VPS DNS Manager — TLD `.vn` không được hỗ trợ; DNS quản lý tại Mắt Bão.
