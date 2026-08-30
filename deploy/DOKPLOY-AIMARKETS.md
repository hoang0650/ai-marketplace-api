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
# Bắt buộc có www — Vercel redirect aimarkets.vn → www.aimarkets.vn
CORS_ORIGINS=https://aimarkets.vn,https://www.aimarkets.vn,http://localhost:4200,http://127.0.0.1:4200
GOOGLE_CLIENT_ID=<web-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
AIMARKETS_API_HOST=https://api.aimarkets.vn
AIMARKETS_AI_HOST=https://ai.aimarkets.vn
```

Deploy từ GitHub: `hoang0650/ai-marketplace-api` branch `master`.

### Kiểm tra

```bash
curl -s https://api.aimarkets.vn/health
curl -s "https://api.aimarkets.vn/v1/products?limit=1"
```

## Traefik (Dokploy → Traefik File System)

1. **`traefik.yml`** — giữ `openclaw/deploy/dokploy-traefik.yml` (HTTP→HTTPS + Let's Encrypt HTTP-01).
2. **`dynamic/middlewares.yml`** — `openclaw/deploy/dokploy-dynamic-middlewares.yml`.
3. **`dynamic/aimarkets.yml`** — `ai-marketplace-api/deploy/dokploy-dynamic-aimarkets.yml` (CORS/security headers).

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
