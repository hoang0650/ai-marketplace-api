# AI Markets SSH sandbox gateway

Gives each buyer temporary SSH into **their own** sandbox container. Never the host sshd, never a shared account.

```
buyer ──ssh -p 2422 oc-<userId>@ssh.aimarkets.vn──▶ gateway (ssh2, container)
                                                     │ POST /v1/ssh-gateway/auth   (X-SSH-Gateway-Secret)
                                                     ├──────────────────────────▶ AI Markets API (scrypt hash check,
                                                     │                             expiry/revoke/flag checks)
                                                     │ docker exec (via socket proxy: containers+exec only)
                                                     ▼
                                     aim-sbx-<agent>-<userId>   (uid 1000, cap_drop ALL, no-new-privileges,
                                                                 read-only rootfs, mem/cpu/pids caps,
                                                                 only volume aim-sbx-<agent>-<userId>-ws at /workspace,
                                                                 network aim-sbx-net: no ICC, private ranges blocked)
```

* **Credentials**: `POST /v1/openclaw/ssh/generate` issues `oc-<userId>` + a random password, stores only a scrypt hash, and shows the password once. 60-minute TTL. Reissuing revokes the previous one.
* **Auth**: password only, verified by the API on every login. Unknown/expired/revoked credentials and agents whose `*_SSH_PER_USER_ISOLATION` flag is off are rejected server-side. The gateway also checks that the API's answer matches the login name, and limits failed logins per IP.
* **Sandbox lifecycle**: created and started on first login. The reaper runs every 60 s, polls `GET /v1/ssh-gateway/active`, ends live connections and removes containers with no active session (expiry, revoke, subscription lapse via `revokeAgentSsh`). Each connection is also closed at `expiresAt`. Workspace volumes are kept between sessions.
* **Channels**: shell, exec and sftp run as `docker exec` with uid 1000 inside the sandbox. Port forwarding, agent forwarding, X11 and streamlocal are refused.
* **Reuse**: usernames `hm-` / `nc-` / `sb-` map to Hermes / NanoClaw / SpaceBot. To use them, switch that route's `ssh/generate` to `issueIsolatedSshSession` (see `src/services/ssh-sandbox.js`) and set its isolation flag.

## Deploy (Hostinger, reversible)

Run as root on the host. This doesn't change sshd, Dokploy or any existing container.

```sh
# 0. Make sure nothing is already listening on 2422
ss -ltnp | grep ':2422' && echo "port busy, choose another SSH_GATEWAY_PUBLIC_PORT"

# 1. Code and secrets
mkdir -p /opt/aim-ssh-gateway && cd /opt/aim-ssh-gateway
#    copy infra/ssh-gateway/* here (git archive or scp)
cp .env.example .env && chmod 600 .env
#    set SSH_GATEWAY_SHARED_SECRET (openssl rand -base64 48), using the SAME value as the API env

# 2. Build images and start
docker compose --profile build build
docker compose up -d gateway docker-proxy
docker compose logs -f gateway           # expect {"event":"listening","port":2222}

# 3. Sandbox egress firewall (DOCKER-USER rules + block sandbox→host)
./firewall-sandbox-egress.sh             # undo: ./firewall-sandbox-egress.sh --remove
#    if the host firewall (ufw / Hostinger panel) filters inbound, open TCP 2422

# 4. DNS: ssh.aimarkets.vn  A  72.62.72.165   (DNS only / not proxied)

# 5. API (Dokploy env), then redeploy the API:
#    SSH_GATEWAY_SHARED_SECRET=<same value>
#    SSH_GATEWAY_HOST=ssh.aimarkets.vn
#    SSH_GATEWAY_PORT=2422
#    OPENCLAW_SSH_PER_USER_ISOLATION=1      # only after steps 1-4 have been verified with a test buyer
```

Test with a test-buyer account: generate on the setup page, then `ssh -p 2422 oc-<id>@ssh.aimarkets.vn`. Check `id` (uid=1000), `ls /var/run/docker.sock` (missing), `curl -m3 http://172.17.0.1` (blocked), and that revoke drops the session within about 60 s.

**Rollback**: set `OPENCLAW_SSH_PER_USER_ISOLATION=0` (the API fails closed with 403), then run
`docker compose down`, `docker rm -f $(docker ps -aq --filter label=vn.aimarkets.sandbox=1)`, and
`./firewall-sandbox-egress.sh --remove`. Add `docker volume ls -q | grep '^aim-sbx-' | xargs -r docker volume rm` to also delete buyer files.

## Tests

`npm test` covers the spec hardening checks, the demuxer, username parsing and the rate limiter. It also runs an end-to-end ssh2 test against a fake API and fake docker: wrong password, `root` login, port forwarding, revoke and reaper.
