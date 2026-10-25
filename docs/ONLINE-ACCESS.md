# Online-only access (datasets, skills, AI films, stories)

Buyers of products in the categories `dataset`, `skill-pack`, `ai-film-series` and `story-book`
use them **online only**. Raw files are never handed to a buyer. The seller still downloads their
own files. Admins keep a moderation download, marked with the response header `X-Access: moderation`.

Every request is authenticated (a Bearer JWT or a per-product `mk_live_…` API key) and checked
against an **active license that belongs to the caller** (`X-License-Key`, owner-bound). When the
license expires, the next request is refused with `402 LICENSE_EXPIRED`.

| Area | Endpoint | Notes |
|---|---|---|
| Dataset meta | `GET /v1/datasets/:slug` | splits, columns, row counts, README, license notices, quota |
| Dataset rows | `GET /v1/datasets/:slug/rows?split=train&offset=0&limit=100` | paginated; each row has `_aim.wm` (buyer watermark); `X-Trace-Id` |
| Skill loader | `GET /v1/skills/:slug/loader.zip` | public thin OpenClaw loader (no product code) |
| Skill run | `POST /v1/skills/:slug/run` | runs server-side in the AI service sandbox; no client cache |
| Skill resources | `GET /v1/skills/:slug/resources/prompts/...` | prompts/schema/examples/templates only |
| Film / story | `POST /v1/content/unlock` → `GET /v1/content/play/:token` | 5-min HMAC play token; license re-checked on every (range) request |
| Raw files | `GET /v1/products/:id/files/:fid/download`, `/v1/content/episodes/:id/download` | buyer → `403 ONLINE_ONLY`; seller/admin only |

## Default quotas (per buyer and product; env overrides)

| Kind | Default | Env |
|---|---|---|
| Dataset rows | limit 100 (max 500) per page, 60 req/min, 3,000 rows/min, 30,000 rows/day | `ONLINE_DATASET_MAX_LIMIT`, `ONLINE_DATASET_RPM`, `ONLINE_DATASET_ROWS_PER_MIN`, `ONLINE_DATASET_ROWS_PER_DAY` |
| Skill runs | 30/min, 1,000/day | `ONLINE_SKILL_RPM`, `ONLINE_SKILL_RUNS_PER_DAY` |
| Film/story unlocks | 60/min, 1,500/day | `ONLINE_PLAY_UNLOCK_RPM`, `ONLINE_PLAY_UNLOCKS_PER_DAY` |
| Story page reads | 120/min, 3,000/day | `ONLINE_READ_PAGES_PER_MIN`, `ONLINE_READ_PAGES_PER_DAY` |

A request over quota gets `429 QUOTA_EXCEEDED` with `retryAfter` (seconds).

## Training import

`POST /v1/training-datasets/licensed/:productId/import` uses the same owner-bound license check. The copy stays
in private training storage with no download URL. Jobs re-check the license before they start, and
licensed datasets can only train on the shared AI Markets GPU, never on a rented GPU
(`409 LICENSED_DATASET_SHARED_ONLY`).

## Third-party skills

Skills only run on the server when the product is `PLATFORM_DIRECT` or has
`contentMeta.onlineRunApproved: true` (set by an admin after review). Otherwise the response is
`409 SKILL_ONLINE_RUN_NOT_APPROVED`.
