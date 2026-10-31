# Per-user Hermes and NanoClaw on the Hostinger runtime

The API stays on Dokploy. Containers run on the same Hostinger machine (`72.62.72.165`) through the existing `docker-proxy` used by `aim-sbx` / `aim-skill-sandbox`. Do not point this at another host. Do not change `BYOK_ENCRYPTION_KEY`.

Flags stay **off** until the steps below are done. While they are off, `POST /v1/hermes/launch` and `POST /v1/nanoclaw/launch` return `503` `RUNTIME_ISOLATION_MAINTENANCE`.

SpaceBot is unlisted. Launch and new subscriptions return `403` `SPACEBOT_UNLISTED`. Existing rows and the volumes `spacebot-aimarkets-data` and `spacebot-post-limit-recovery-20261029` are not deleted.

## What a tenant is

| Piece | Name |
| --- | --- |
| Container | `aim-agent-<hermes\|nanoclaw>-<userId>` |
| Data volume | `aim-agent-<agent>-<userId>-data` (only mount, at `/data`) |
| Network | `aim-agent-net-<userId>` (one per buyer, ICC off, no masquerade) |
| Secret | `/run/secrets/byok.json`, written at start, mode `0400`, not in image env |
| Limits | 512 MB RAM, 0.5 CPU, 256 pids, read-only rootfs, `cap_drop ALL`, `no-new-privileges` |
| Idle | stopped 15 minutes after the last launch, `/usage` call, or platform chat |

Two buyers do not share a volume or a network. Egress is the allowlist proxy on the network gateway (`HTTP(S)_PROXY=http://<gateway>:3128`): `api.aimarkets.vn`, plus the buyer's provider host when they use their own key. Platform mode does not get a path to provider hosts. Containers publish on `127.0.0.1` only.

`HERMES_AIMARKETS_TENANT_ISOLATED=1` or `NANOCLAW_AIMARKETS_TENANT_ISOLATED=1` is set inside the container. That is the signal the image uses to accept logins and, for Hermes, to allow tools. It is not a secret.

## API environment (Dokploy → aimarketplace-api)

Leave the flags at `0` for the first deploy.

```env
HERMES_BUYER_RUNTIME_ENABLED=0
NANOCLAW_BUYER_RUNTIME_ENABLED=0
TENANT_DOCKER_HOST=tcp://docker-proxy:2375
HERMES_TENANT_IMAGE=aimarkets/hermes-aimarkets:tenant
NANOCLAW_TENANT_IMAGE=aimarkets/nanoclaw-agent:tenant
TENANT_COPY_IMAGE=busybox:1.36
TENANT_IDLE_SWEEPER=on
AIMARKETS_API_HOST=https://api.aimarkets.vn
# Platform model. This key stays on the API. It is not injected into containers.
AIMARKETS_PLATFORM_OPENAI_BASE_URL=https://api.openai.com/v1
AIMARKETS_PLATFORM_OPENAI_KEY=
# Unchanged. Rotating it makes every stored buyer key unreadable.
BYOK_ENCRYPTION_KEY=
```

`docker-proxy` must be the proxy already used by the SSH gateway, on the Docker network the API can reach. Do not mount `docker.sock` into tenant containers.

Buyer key mode: the container's secret file holds that buyer's key. `POST /v1/<agent>/usage` records `charged: 0`, `reason: byok`. The monthly hosting fee is unchanged.

Platform mode (no `AgentProviderSetting`): the secret file holds a per-container runtime token whose hash is stored on `TenantAgent`. The container calls `POST /v1/tenant/openai/chat/completions`. The API adds `AIMARKETS_PLATFORM_OPENAI_KEY` and debits the wallet.

`GET /v1/<agent>/provider` returns `keySource` (`buyer` or `platform`) and `keySourceLabel` in `vi`, `en`, and `zh` (`Using: your key` / `Using: AI Markets key`). The key itself is only the last 4 characters.

Admin look-up is `POST /v1/admin/tenant-runtime/:agentId/:userId` with `{ "reason": "..." }` (at least 5 characters). It writes an audit log and does not return the key.

## Images

Build the tenant images from the Hermes and NanoClaw branches and tag them as `HERMES_TENANT_IMAGE` and `NANOCLAW_TENANT_IMAGE`. The Hermes image must honour `HERMES_AIMARKETS_TENANT_ISOLATED=1`. Do not put `AIMARKETS_SERVICE_SECRET` or a provider key in the image env.

Codex's open pull requests are the base. Follow-up commits (secret file, owner check, Hermes tools only when the tenant flag is set, OpenClaw session-id boundary) are in `deploy/agent-followups/*.patch`. This agent's token cannot push to `hoang0650/nanoclaw`, `hoang0650/hermes-agent`, or `hoang0650/openclaw`. Apply them on top of `codex/byok-tenant-isolation-20261029`:

```bash
git checkout codex/byok-tenant-isolation-20261029
git am ../ai-marketplace-api/deploy/agent-followups/nanoclaw.patch
```

Use the matching patch in `hermes-agent` and `openclaw`. OpenClaw stays a shared gateway with the credential fence from that PR. It does not get one container per buyer.

## Migration (runtime host, not the API database)

Dry-run first. This never deletes `nanoclaw-aimarkets-data` or `hermes-aimarkets-data`.

```bash
# On the runtime host, list paths inside the shared volume (read-only) into paths.json
# as a JSON array of relative paths such as "market-<userId>/memory.json".
node scripts/migrate-tenant-volumes.js \
  --agent nanoclaw \
  --volume nanoclaw-aimarkets-data \
  --paths paths.json
```

Review the printed backup name and per-user volumes. Then, still on the runtime host:

1. `docker volume create nanoclaw-aimarkets-data-backup-<stamp>` using the stamp from the dry-run.
2. Copy the shared volume into that backup with a throwaway container. Mount the source read-only.
3. For each `copy-path` action, copy only that buyer's tree into `aim-agent-nanoclaw-<userId>-data`.
4. Leave `nanoclaw-aimarkets-data` in place. Do not `docker volume rm` it.
5. Repeat for `hermes-aimarkets-data` with `--agent hermes` if that volume exists.
6. Do not migrate SpaceBot volumes.

`TENANT_MIGRATE_APPLY=1 node scripts/migrate-tenant-volumes.js --apply ...` prints the same actions. It does not talk to Docker and does not delete anything.

## Egress

On the runtime host, for each `aim-agent-net-*` bridge:

- ICC is already off (containers on the network cannot talk to each other).
- Masquerade is off (no direct internet).
- Run an allowlist proxy on the bridge gateway, port `3128`.
- Forward only ports 80 and 443 from that bridge to the proxy. Drop everything else, including private ranges and the metadata address `169.254.169.254`.
- Platform-mode containers may reach `api.aimarkets.vn` only. BYOK containers may also reach the one provider host stored for that buyer.

## Turn it on

1. Deploy this API with the flags still `0`. Confirm `GET /health` and that SpaceBot is absent from `GET /v1/agents/pricing` (`listed: false`) and from `GET /v1/agent-templates`.
2. Confirm `POST /v1/hermes/launch` returns `RUNTIME_ISOLATION_MAINTENANCE`.
3. Finish the volume migration and the egress proxy.
4. Set `HERMES_BUYER_RUNTIME_ENABLED=1` and `NANOCLAW_BUYER_RUNTIME_ENABLED=1`, then redeploy the API.
5. Point Traefik at the new containers before expecting the public hostname to open. Each container publishes its port on `127.0.0.1` only. The wildcard files that send every `{userId}.hermes.aimarkets.vn` host to one upstream will not reach these containers. Add a router per running container to `http://127.0.0.1:<published port>` (Hermes listens on 9119 inside the container, NanoClaw on 3100).
6. Launch one buyer. `docker ps` should show `aim-agent-hermes-<userId>` or `aim-agent-nanoclaw-<userId>` only after that buyer's launch. `docker inspect` must show a read-only root, `CapDrop: ALL`, no binds, and no provider key in `Env`.

Expired subscriptions still flow through `/v1/admin/agent-purges`. For Hermes and NanoClaw, with the flags and `TENANT_DOCKER_HOST` set, purge copies the data volume to `aim-agent-<agent>-<userId>-backup-<stamp>` and only then removes the container and the data volume.

## SSH

`GET /v1/<agent>/ssh/active` no longer returns `password` or `privateKey`. New password sessions store a scrypt hash. A legacy plaintext row is hashed and cleared the next time its owner opens the active session. The password is still shown once from `POST /ssh/generate`.
