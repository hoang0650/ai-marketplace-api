# Seller GPU / Game streaming integration

Connect **external** GPU/game infrastructure **or** **AI Markets–hosted RunPod Pods** (via denglish-api / ai.aimarkets.vn) so buyers can **stream or play on aimarkets.vn (PC) or in the mobile app** — without exposing internal IPs.

## Overview

| Role | Action |
|------|--------|
| Seller | Publish product (`gpu-compute` or `game-server`), register compute node(s) for `pc` and/or `mobile` |
| Buyer | `POST /v1/game-sessions { "productSlug": "...", "client"?: "pc" \| "android" \| "ios" }` → embedded player, heartbeat every 30 s |
| Platform | Resolve node for the device → proxy stream → debit wallet **every minute** while live |

**Node resolution order:**

- Seller listings: external seller node first → fallback to hosted RunPod Pod.
- Listings sold directly by AI Markets (`PLATFORM_DIRECT`): hosted pod first → external node.

Categories: `gpu-compute`, `game-server`  
Recommended pricing: `usage` (per hour/minute/second, USD)

## 1. Register a compute node

**Auth:** Seller JWT (`seller` or `admin`)

### External (your infrastructure)

```http
POST /v1/seller/compute/nodes
Authorization: Bearer <seller_jwt>
Content-Type: application/json

{
  "hosting": "external",
  "productSlug": "my-game-box",
  "name": "EU Game Box",
  "kind": "game",
  "webhookUrl": "https://seller.example.com/aimarkets/webhook",
  "webhookSecret": "whsec_...",
  "streamHost": "10.0.0.5",
  "streamPort": 6080,
  "streamPath": "/",
  "streamKind": "novnc",
  "healthUrl": "https://seller.example.com/health",
  "region": "eu-west",
  "maxConcurrent": 10,
  "devices": ["pc", "mobile"],
  "mobileStream": { "host": "10.0.0.5", "port": 6081, "path": "/", "kind": "novnc" }
}
```

**Static stream only (no webhook):** omit `webhookUrl` and set `streamHost` + `streamPort`.  
**iframe embed:** set `iframeUrl` (HTTPS) instead of host/port.

### Devices (PC & mobile)

- `devices`: `["pc"]`, `["mobile"]` or both. Empty/omitted = serves both.
- The listing's supported devices are the union of `devices` across its online nodes (`product.streaming.devices`).
- `mobileStream` (optional): separate upstream for the mobile build — `{ host, port, path, kind, tls }` or `{ iframeUrl }`. Without it, mobile uses the main stream.

| Device | Client | Profile |
|--------|--------|---------|
| `pc` | web / desktop | 1920×1080 · 60 fps · 15 000 kbps · keyboard, mouse, gamepad |
| `mobile` | Android / iOS app | 1280×720 · 60 fps · 6 000 kbps · touch, virtual gamepad, gamepad · landscape |

### AI Markets hosted (RunPod Pod)

No webhook required — stream is resolved via denglish-api `getConnection` (noVNC port 6080).

```http
POST /v1/seller/compute/nodes
Authorization: Bearer <seller_jwt>
Content-Type: application/json

{
  "hosting": "aimarkets",
  "productSlug": "my-game-box",
  "name": "RunPod Game Box",
  "kind": "game",
  "gpuType": "NVIDIA GeForce RTX 4090",
  "provider": "runpod",
  "maxConcurrent": 5
}
```

Shortcut: `POST /v1/seller/compute/nodes/hosted` with the same body.

When a buyer starts a session, the platform **starts the pod if stopped**, polls until running, then proxies the stream.

List / update / offline:

- `GET /v1/seller/compute/nodes`
- `PATCH /v1/seller/compute/nodes/:id` — webhook, stream, `devices`, `mobileStream`, `maxConcurrent`, online/offline
- `DELETE /v1/seller/compute/nodes/:id` — external: marks offline; hosted: terminates RunPod pod
- `POST /v1/seller/compute/nodes/:id/ping` — external: health/webhook; hosted: RunPod connection
- `GET /v1/seller/compute/schema` — JSON integrator schema

## 2. Webhook contract (external only)

AI Markets POSTs JSON to `webhookUrl` with header:

```http
X-AIM-Signature: <hmac-sha256-hex of raw body using webhookSecret>
User-Agent: AI-Markets-Compute/1.0
```

### Events

| Event | When |
|-------|------|
| `session.start` | Buyer started a session — **return stream upstream** |
| `session.stop` | Session ended (billing finalized) |
| `session.ping` | Health check from seller dashboard |

### `session.start` payload (example)

```json
{
  "event": "session.start",
  "timestamp": "2026-08-31T12:00:00.000Z",
  "sessionId": "gs_a1b2c3d4e5f67890",
  "productSlug": "my-game-box",
  "buyerId": "665f...",
  "buyerEmail": "buyer@example.com",
  "nodeId": "ext_abc123",
  "client": "android",
  "device": "mobile",
  "profile": {
    "device": "mobile",
    "maxWidth": 1280,
    "maxHeight": 720,
    "fps": 60,
    "bitrateKbps": 6000,
    "inputs": ["touch", "virtual-gamepad", "gamepad"],
    "orientation": "landscape"
  }
}
```

Use `device` / `profile` to launch the right build and encoder settings.

### Response (dynamic stream)

Return JSON with internal stream endpoint (never sent to browser directly — proxied):

```json
{
  "streamHost": "10.0.0.5",
  "streamPort": 6080,
  "streamPath": "/",
  "streamKind": "novnc",
  "streamTls": false
}
```

Supported `streamKind`: `novnc`, `hls`, `iframe`, `sandbox`

- The platform waits up to 15 s for the webhook response.
- Webhook returns a non-2xx status → session start fails with `502 WEBHOOK_FAILED`.
- Webhook returns 200 without a stream → the node's static config is used (`mobileStream` for mobile when set).

## 3. Buyer session API

**Auth:** Buyer JWT (`buyer`, `seller`, or `admin`)

```http
POST /v1/game-sessions
Authorization: Bearer <buyer_jwt>
Content-Type: application/json

{ "productSlug": "my-game-box", "client": "pc" }
```

`client` is optional (`pc`, `android`, `ios`) — otherwise it is detected from the `User-Agent`. `android`/`ios` map to device `mobile`.

**Response:**

```json
{
  "sessionId": "gs_...",
  "productSlug": "my-game-box",
  "hosting": "external",
  "status": "live",
  "client": "pc",
  "device": "pc",
  "profile": { "device": "pc", "maxWidth": 1920, "maxHeight": 1080, "fps": 60, "bitrateKbps": 15000, "inputs": ["keyboard", "mouse", "gamepad"], "orientation": "any" },
  "streamKind": "novnc",
  "playerUrl": "https://api.aimarkets.vn/v1/game-sessions/gs_.../player",
  "publicUrl": "https://gs-....proxvn.example/...",
  "heartbeatMs": 30000,
  "idleTimeoutMs": 300000,
  "billedMinutes": 0,
  "billedCost": 0
}
```

**Seats:** one session per buyer per listing. Starting again on the same device reuses the running session; switching PC ↔ mobile stops the old one first (`stopReason: "switched_device"`) so the buyer is never billed twice. A buyer may run up to 4 listings at once (`GAME_MAX_SESSIONS`); the oldest is reclaimed first when possible (`slot_reclaimed`), otherwise `429 TOO_MANY_STREAMS`.

Embed in your frontend:

```
GET {playerUrl}?access_token={JWT}
```

Keep-alive (every `heartbeatMs`):

```http
POST /v1/game-sessions/{sessionId}/heartbeat
```

Response: `{ "ok": true, "status": "live", "device": "pc", "heartbeatMs": 30000, "ratePerHour": 1.2, "billedMinutes": 12, "billedCost": 0.24, "currency": "USD", "available": 9.76, "minutesLeft": 488 }`

Other endpoints: `GET /v1/game-sessions/{sessionId}` (status), `GET .../player`, `.../proxy/*`.

Stop session (final bill):

```http
DELETE /v1/game-sessions/{sessionId}
```

Response: `{ "ok": true, "billedCost": 0.42, "billedMinutes": 21 }`

### Errors

| Status | Code | When |
|--------|------|------|
| 402 | `INSUFFICIENT_BALANCE` / `PAYOUT_HELD` | Wallet cannot cover 1 minute |
| 409 | `CLIENT_NOT_SUPPORTED` | Listing does not stream to this device (`supportedDevices` in body) |
| 410 | `SESSION_STOPPED` | Heartbeat on a stopped session (`stopReason`: `user`, `idle`, `insufficient_funds`, `switched_device`, `slot_reclaimed`) |
| 429 | `CAPACITY` | Node is at `maxConcurrent` |
| 429 | `TOO_MANY_STREAMS` | Buyer already runs the maximum number of streams |
| 502 | `WEBHOOK_FAILED` | Seller webhook returned non-2xx |
| 503 | `NO_COMPUTE_NODE` | No online node for this device yet (`supportedDevices` in body) |

## 4. Billing (per minute)

- Applies to `pricing.model = usage`; rate is normalized to USD per hour (`ratePerHour`).
- Before start: available wallet balance must cover at least 1 minute.
- A worker debits the buyer **every minute** while the session is live (`GAME_BILLING_TICK_MS`, default 60 s). On stop, the last partial minute is rounded up (minimum 1 minute per session).
- Under ~5 minutes left (`GAME_LOW_BALANCE_MINUTES`) the buyer gets a low-balance notification; when funds run out the session stops with `insufficient_funds`.
- No heartbeat for 5 minutes (`GAME_IDLE_MS`) → session stops (`idle`). Clients that never heartbeat are capped at 4 hours (`GAME_NO_HEARTBEAT_MAX_MS`).
- Each charge writes a `UsageEvent` (`source: "gpu"`, `usageType` `GAME_RUNTIME` or `GPU_HOUR`) and adds `UsageStat.gpuHours` for the seller.
- Seller receives the net amount after the 20% platform fee (`PLATFORM_COMMISSION_RATE`). Sellers playing their own listing are not charged.

## 5. Security notes

- Stream host/port are **internal** — browser only sees `/v1/game-sessions/:id/proxy/*`
- Verify `X-AIM-Signature` on your webhook handler
- Do not expose RunPod or private IPs in product pages
- Set `maxConcurrent` to cap simultaneous buyers per node
- Hosted pods require `DENGLISH_API_URL` and `RUNPOD_API_KEY` on denglish-api (ai.aimarkets.vn)

## 6. Frontend (AI Markets)

| URL | Purpose |
|-----|---------|
| `/sell/integrate` | Seller register nodes |
| `/play/:productSlug` | Buyer live stream (auth required) |
| Product page CTA | "Play / Stream" for compute categories |
| `/docs/compute-streaming` | Public version of this guide (vi / en / zh) |

Mobile app (Expo, `app/play/[slug].tsx`): sends `client: "android" | "ios"`, heartbeats every `heartbeatMs` and warns the buyer when ≤ 5 minutes of balance are left.

## Related

- [SELLER-API-USAGE.md](./SELLER-API-USAGE.md) — token / inference gateway
- Seller UI: `/sell/docs/api-usage`
