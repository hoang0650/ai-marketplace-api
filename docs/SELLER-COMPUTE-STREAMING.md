# Seller GPU / Game streaming integration

Connect **external** GPU or game-server infrastructure to AI Markets so buyers can **stream or play directly on aimarkets.vn** — without exposing your internal IPs.

## Overview

| Role | Action |
|------|--------|
| Seller | Publish product (`gpu-compute` or `game-server`), register compute node |
| Buyer | `POST /v1/game-sessions { "productSlug": "..." }` → embedded player |
| Platform | Webhook to seller, proxy stream, bill wallet on session stop |

Categories: `gpu-compute`, `game-server`  
Recommended pricing: `usage` (per hour/minute)

## 1. Register a compute node

**Auth:** Seller JWT (`creator` or `admin`)

```http
POST /v1/seller/compute/nodes
Authorization: Bearer <seller_jwt>
Content-Type: application/json

{
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
  "maxConcurrent": 10
}
```

**Static stream only (no webhook):** omit `webhookUrl` and set `streamHost` + `streamPort`.  
**iframe embed:** set `iframeUrl` instead of host/port.

List / update / offline:

- `GET /v1/seller/compute/nodes`
- `PATCH /v1/seller/compute/nodes/:id`
- `DELETE /v1/seller/compute/nodes/:id` (marks offline)
- `POST /v1/seller/compute/nodes/:id/ping`
- `GET /v1/seller/compute/schema` — JSON integrator schema

## 2. Webhook contract

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
  "nodeId": "ext_abc123"
}
```

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

If webhook fails or returns no stream, static config on the node is used as fallback.

## 3. Buyer session API

**Auth:** Buyer JWT (`buyer`, `creator`, or `admin`)

```http
POST /v1/game-sessions
Authorization: Bearer <buyer_jwt>
Content-Type: application/json

{ "productSlug": "my-game-box" }
```

**Response:**

```json
{
  "sessionId": "gs_...",
  "productSlug": "my-game-box",
  "status": "live",
  "streamKind": "novnc",
  "playerUrl": "https://api.aimarkets.vn/v1/game-sessions/gs_.../player",
  "publicUrl": "https://gs-....proxvn.example/..."
}
```

Embed in your frontend:

```
GET {playerUrl}?access_token={JWT}
```

Stop session (triggers billing):

```http
DELETE /v1/game-sessions/{sessionId}
```

Response: `{ "ok": true, "billedCost": 0.42 }`

## 4. Billing

- Sessions with `pricing.model = usage` are billed on `DELETE` by elapsed minutes
- Creates `UsageEvent` with `source: "gpu"`
- Debits buyer wallet, credits seller (minus platform fee)
- Minimum balance check before start for usage products

## 5. Security notes

- Stream host/port are **internal** — browser only sees `/v1/game-sessions/:id/proxy/*`
- Verify `X-AIM-Signature` on your webhook handler
- Do not expose RunPod or private IPs in product pages
- Set `maxConcurrent` to cap simultaneous buyers per node

## 6. Frontend (AI Markets)

| URL | Purpose |
|-----|---------|
| `/sell/integrate` | Seller register nodes |
| `/play/:productSlug` | Buyer live stream (auth required) |
| Product page CTA | "Play / Stream" for compute categories |

## Related

- [SELLER-API-USAGE.md](./SELLER-API-USAGE.md) — token / inference gateway
- Seller UI: `/sell/docs/api-usage`
