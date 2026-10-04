# Dokploy + Traefik — AI Markets (aimarkets.vn)

VPS Hostinger `72.62.72.165` · Dokploy `deploy.phgrouptechs.com` · DNS **Mắt Bão** (không dùng Hostinger DNS Manager cho `.vn`).

## DNS (Mắt Bão)

| Host | Type | Value |
|------|------|-------|
| `@` | A | IP frontend (Vercel hoặc VPS) |
| `www` | CNAME | Vercel / frontend |
| `api` | A | `72.62.72.165` |
| `ai` | A | `72.62.72.165` |
| `openclaw` | A | `72.62.72.165` → `openclaw.aimarkets.vn` |
| `*.openclaw` | A | `72.62.72.165` → `{userId}.openclaw.aimarkets.vn` |
| `hermes` | A | `72.62.72.165` → `hermes.aimarkets.vn` |
| `*.hermes` | A | `72.62.72.165` → `{userId}.hermes.aimarkets.vn` |
| `nanoclaw` | A | `72.62.72.165` → `nanoclaw.aimarkets.vn` |
| `*.nanoclaw` | A | `72.62.72.165` → `{userId}.nanoclaw.aimarkets.vn` |
| `openwebui` | A | `72.62.72.165` → `openwebui.aimarkets.vn` |
| `*.openwebui` | A | `72.62.72.165` → `{userId}.openwebui.aimarkets.vn` |
| `paperclip` | A | `72.62.72.165` → `paperclip.aimarkets.vn` |
| `*.paperclip` | A | `72.62.72.165` → `{userId}.paperclip.aimarkets.vn` |

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
AI_URL=https://ai.aimarkets.vn
OPENCLAW_AIMARKETS_PUBLIC_URL_TEMPLATE=https://{userId}.openclaw.aimarkets.vn
OPENCLAW_SSH_HOST_TEMPLATE={userId}.openclaw.aimarkets.vn
# Bắt buộc — cùng giá trị trên service OpenClaw (hotelapp auto-login / auto-approve)
OPENCLAW_GATEWAY_TOKEN=<shared-secret-min-24-chars>
HERMES_AIMARKETS_PUBLIC_URL_TEMPLATE=https://{userId}.hermes.aimarkets.vn
HERMES_SSH_HOST_TEMPLATE={userId}.hermes.aimarkets.vn
NANOCLAW_AIMARKETS_PUBLIC_URL_TEMPLATE=https://{userId}.nanoclaw.aimarkets.vn
NANOCLAW_SSH_HOST_TEMPLATE={userId}.nanoclaw.aimarkets.vn
# Optional — same as NanoClaw DASHBOARD_SECRET when auth is enabled
NANOCLAW_DASHBOARD_SECRET=<shared-secret-min-24-chars>
# Optional — only if you expose aimarkets-proxy :3200 behind ProxVN
# NANOCLAW_USE_LOGIN_PROXY=1
AIMARKETS_SERVICE_SECRET=<shared with OpenClaw/Hermes aimarkets-usage plugins>
# Cùng giá trị trên OpenClaw gateway — ký market ticket + suy ra gateway token AI Markets
OPENCLAW_MARKET_TICKET_SECRET=<min-32-chars>
OPENCLAW_AIMARKETS_MARKUP=0.25
# Open WebUI / Paperclip SSO — cùng giá trị trên service tương ứng (thiếu → launch 503)
OPENWEBUI_SSO_SECRET=<min-32-chars>
PAPERCLIP_SSO_SECRET=<min-32-chars, khác OPENWEBUI_SSO_SECRET>
OPENWEBUI_AIMARKETS_PUBLIC_URL_TEMPLATE=https://{userId}.openwebui.aimarkets.vn
PAPERCLIP_AIMARKETS_PUBLIC_URL_TEMPLATE=https://{userId}.paperclip.aimarkets.vn
```

**OpenClaw auto-login / auto-approve:** Launch trả URL hash `#gatewayUrl&token&autoConnect` (giống hotelapp). Khi API có cả `AIMARKETS_SERVICE_SECRET` và `OPENCLAW_MARKET_TICKET_SECRET`, token trong URL là token AI Markets suy ra từ hai secret này (gateway cũng tự suy ra, chỉ chấp nhận trên `*.openclaw.aimarkets.vn`), nên API không cần `OPENCLAW_GATEWAY_TOKEN` của PHHotel. Gateway và PHGroup-AI vẫn phải cùng `OPENCLAW_GATEWAY_TOKEN` cho PHHotel và cho auto-approve device pairing. Thiếu/sai token → Control UI `unauthorized` / `token_mismatch`, không tới bước device pairing approve.

**NanoClaw Launch:** `POST /v1/nanoclaw/launch` → `https://{userId}.nanoclaw.aimarkets.vn/dashboard?…`. Chi tiết: `nanoclaw/deploy/DOKPLOY-AIMARKETS.md`.

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

## Ponytail (`aimarketplace-ponytail`)

Service nội bộ (không cần domain) phát bộ quy tắc Ponytail cho mọi runtime agent để agent viết ít code thừa hơn, giảm token output khách hàng phải trả. Hướng dẫn tạo app: `ponytail/deploy/DOKPLOY.md` (Dockerfile, port `8787`).

Env thêm trên **OpenClaw, Hermes, NanoClaw, Paperclip, Open WebUI, SpaceBot** rồi redeploy từng app:

```env
PONYTAIL_URL=http://aimarketplace-ponytail:8787
PONYTAIL_MODE=compact   # lite | full | ultra | off
```

API không tham gia: runtime tự lấy quy tắc, cache 10 phút, service sập thì chat vẫn chạy bình thường.

## Traefik (Dokploy → Traefik File System)

1. **`traefik.yml`** — giữ `openclaw/deploy/dokploy-traefik.yml` (HTTP→HTTPS + Let's Encrypt HTTP-01).
2. **`dynamic/middlewares.yml`** — `openclaw/deploy/dokploy-dynamic-middlewares.yml`.
3. **`dynamic/aimarkets.yml`** — `ai-marketplace-api/deploy/dokploy-dynamic-aimarkets.yml` (CORS/security headers).
4. **`dynamic/openclaw-aimarkets-wildcard.yml`** — `openclaw/deploy/dokploy-dynamic-openclaw-aimarkets-wildcard.yml` (**thêm**, không thay file `{hotelId}.phhotel.vn`). File **phải có** `services.openclaw-aimarkets-svc` → upstream `:8080`.
5. **`dynamic/hermes-aimarkets-wildcard.yml`** — `hermes-agent/deploy/dokploy-dynamic-hermes-aimarkets-wildcard.yml` (dashboard port **9119** + `services.hermes-aimarkets-svc`).
6. **`dynamic/nanoclaw-aimarkets-wildcard.yml`** — `nanoclaw.aimarkets.vn` + `*.nanoclaw.aimarkets.vn` → NanoClaw `:3100`.
7. **`dynamic/aimarkets-user-certs.yml`** — exact `Host()` + `domains.main` per buyer (same LE HTTP-01 as denglish `ai.aimarkets.vn`). Template: `dokploy-dynamic-aimarkets-user-certs.yml`. VPS: `python3 openclaw/deploy/_apply-aimarkets-user-certs.py <userId>`. Without this, `{userId}.hermes|nanoclaw|openclaw|openwebui|paperclip` stays on **TRAEFIK DEFAULT CERT**.

**OpenClaw AI Markets:** Control UI `https://{userId}.openclaw.aimarkets.vn` (userId = Mongo ObjectId 24 hex). DNS `openclaw` + `*.openclaw` A → `72.62.72.165`. Session `market-{userId}`, `audience=aimarkets`. Luồng PHHotel `{hotelId}.phhotel.vn` giữ nguyên.

**Hermes AI Markets:** Dashboard `https://{userId}.hermes.aimarkets.vn` (cùng userId). DNS `hermes` + `*.hermes` A → `72.62.72.165`. Session `market-{userId}`, `audience=aimarkets`. API: `/v1/hermes/launch|ssh|usage`.

**NanoClaw AI Markets:** `https://{userId}.nanoclaw.aimarkets.vn` (cùng pattern Hermes/OpenClaw). API: `/v1/nanoclaw/launch|ssh|usage`. Xem `nanoclaw/deploy/DOKPLOY-AIMARKETS.md`.

**Open WebUI AI Markets:** `POST /v1/openwebui/launch` → `https://{userId}.openwebui.aimarkets.vn/api/v1/aimarkets/sso?ticket=…` (HMAC `aimr.v1.openwebui.`, TTL 2 phút, dùng 1 lần) → tài khoản riêng role `user` → `/auth`. Không SSH, không pairing, BYOK qua Direct Connections. Image `ghcr.io/hoang0650/open-webui-aimarkets` (fork, workflow `docker-dokploy.yml`), service `aimarketplace-openwebui:8080`, volume `/app/backend/data`. Env tối thiểu:

```env
WEBUI_SECRET_KEY=<random>
OPENWEBUI_SSO_SECRET=<giống API>
ENABLE_PERSISTENT_CONFIG=false
ENABLE_SIGNUP=false
ENABLE_LOGIN_FORM=false
ENABLE_DIRECT_CONNECTIONS=true
ENABLE_OPENAI_API=false
ENABLE_OLLAMA_API=false
WEBUI_ADMIN_EMAIL=<admin nền tảng>
WEBUI_ADMIN_PASSWORD=<...>
```

Traefik: `open-webui/deploy/dokploy-dynamic-openwebui-aimarkets-wildcard.yml`. Giữ branding "Open WebUI" (license bắt buộc khi > 50 user).

**Paperclip AI Markets:** `POST /v1/paperclip/launch` → `https://{userId}.paperclip.aimarkets.vn/api/auth/aimarkets/sso?ticket=…` (Better Auth plugin) → user + company riêng (owner) → `/`. Image `ghcr.io/hoang0650/paperclip-aimarkets` (stage `production`), service `aimarketplace-paperclip:3100`, volume `/paperclip`, healthcheck `/api/health`. Env: `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `PAPERCLIP_DEPLOYMENT_EXPOSURE=public`, `PAPERCLIP_PUBLIC_URL`, `PAPERCLIP_AGENT_JWT_SECRET`, `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, `PAPERCLIP_SSO_SECRET` (dùng tên `PAPERCLIP_*` — agent process không thừa hưởng biến này), `TRUST_PROXY=1`. Traefik: `paperclip/deploy/dokploy-dynamic-paperclip-aimarkets-wildcard.yml`.

> ⚠️ Agent của Paperclip chạy ngay trong container server, thừa hưởng mọi env (trừ `PAPERCLIP_*`) và đọc được `/paperclip` (DB, `master.key`). Một instance dùng chung **không cô lập** được buyer — chỉ nên mở cho khách tin cậy, hoặc tách 1 container/buyer. Tuyệt đối không đặt provider API key vào env container; buyer nhập key làm company secret.

> **Không build Open WebUI / Paperclip trên VPS** (vite/Rust build OOM). GitHub Actions (`docker-dokploy.yml` của mỗi fork) build + push GHCR (public); Dokploy → Provider **Docker**, image `ghcr.io/hoang0650/<open-webui|paperclip>-aimarkets:latest`, không cần registry credentials. Secret repo `DOKPLOY_WEBHOOK_URL` (webhook Deployments của app) để tự redeploy sau mỗi build.

Hire products cần có trong DB: `openwebui-ops-agent`, `paperclip-ops-agent` (web/app map theo `hireProductSlug`).

### Launch → 404 + “Không bảo mật”

Launch client đã đúng (mở URL). Lỗi nằm ở Traefik/TLS/upstream:

1. **404** (chữ trắng trên nền trống) = Traefik không có router/service khớp Host. Paste lại 2 file wildcard **có block `services:`**, sửa URL container (`docker ps | grep -iE 'openclaw|hermes'`), reload Traefik.
2. **Không bảo mật** = thiếu cert cho subdomain. `letsencrypt` HTTP-01 **không** cấp `*.openclaw` / `*.hermes`. Cần DNS-01 (API Mắt Bão/Cloudflare) hoặc cert thủ công SAN `*.openclaw.aimarkets.vn` + `*.hermes.aimarkets.vn`. File yml đã khai `tls.domains` + `sans` sẵn cho khi bật DNS challenge.
3. Hermes còn cần container sống: Command `dashboard --host 0.0.0.0 --port 9119 --no-open` + `HERMES_DASHBOARD_BASIC_AUTH_*`.

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
