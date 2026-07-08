# Path A — Docker Compose on a single Linux VPS

Self-host the **full** Kin stack — chat, the Phase C **live preview**, and the **code
sandbox** — on one Linux server with a public IP, using a **bundled Traefik** that terminates
TLS. This is the recommended baseline for anyone running their own box. **No Cloudflare Tunnel,
no Dokploy, no Swarm.** (For a Mac / workstation behind NAT, use [Path B / tunnel](tunnel.md).)

> **Easiest path: the one-command installer.** `scripts/install-vps.sh` does everything below
> for you — installs Docker, generates secrets, pulls the prebuilt GHCR images, and brings up
> `docker-compose.prod.yml` behind Traefik + Let's Encrypt. This page documents the same stack
> manually, for when you want to understand or customize it.

**Installer:** [`scripts/install-vps.sh`](../../scripts/install-vps.sh) ·
**Compose file:** [`docker-compose.prod.yml`](../../docker-compose.prod.yml)

```
Internet ──TLS──▶ Traefik (:443, bundled)  ──reads container labels──▶
   ├─ your-domain        → app (5000) ;  /ws → ws-server (3001)
   └─ <id>.your-domain   → preview sandbox container (4173), forward-auth gated
```

> The compose bundles a tiny `dockerproxy` (nginx) in front of the docker socket. **Docker
> 28/29+ raised the daemon's minimum API to 1.40, which rejects Traefik's pinned v1.24 client**
> ("client version 1.24 is too old") — on *any* OS, not just macOS. The shim rewrites the API
> version so Traefik works; it's harmless on older Docker. (Verified live on Docker 29 / Ubuntu.)

---

## Critical invariants (get any wrong → it won't serve)

1. **Secrets live OUTSIDE the repo** in `~/kin-deploy/secrets.env` (chmod 600). Never edit
   `.env` / commit secrets. (The `install-vps.sh` path instead writes a chmod-600 `.env`.)
2. **`APP_NAME_SANITIZED` must be unique** on the host — volume names (`${APP_NAME_SANITIZED}-data`
   etc.) are global; a collision reuses another stack's data (→ Postgres `28P01`).
3. **`DATABASE_URL` is built from `POSTGRES_*` inside the compose** — don't pass a separate
   `DATABASE_URL` (it would drift from `POSTGRES_PASSWORD`).
4. **ARK auth = `ANTHROPIC_AUTH_TOKEN` (Bearer)** — do **not** set `ANTHROPIC_API_KEY` (it flips
   the SDK to `x-api-key` and ARK rejects it).
5. **Previews need a wildcard**: DNS `*.<domain>` → the VPS, and a **wildcard TLS cert**
   (`*.<domain>`). The cert is issued once (see TLS below); preview subdomains reuse it — Traefik
   does **not** request a cert per preview.
6. **Image is built off-server → pulled** by default (the SSR build peaks >8 GB; don't build on a
   small VPS). Set `APP_PULL_POLICY=never` + build locally only if the VPS has ≥16 GB RAM.

---

## TLS — two supported options

| Option | When | What you set |
|---|---|---|
| **A. Let's Encrypt DNS-01 (default)** | Pure VPS; you want your own free, auto-renewing certs | `ACME_EMAIL` + `CF_DNS_API_TOKEN` (a Cloudflare token with **Zone:Read** + **DNS:Edit** on the zone). Traefik issues ONE cert for `<domain>` + `*.<domain>` via DNS-01 (HTTP-01 can't do wildcards). |
| **B. Cloudflare Origin CA** | Domain already on Cloudflare, orange-cloud | Origin CA cert in `infra/prod/dynamic/` (see [its README](../../infra/prod/dynamic/README.md)); drop the `tls.certresolver=le` lines from the app `main` router. Proven on the Dokploy path. |

The compose **defaults to option A**. Both are wired; see the comments in the `traefik` service.
If you restrict the Cloudflare token by Client IP, include the VPS public IPv4 and/or IPv6
that Cloudflare sees. The installer checks this before starting the stack.

---

## Steps

### 1. Server + DNS
- A Linux VPS with **Docker + the Compose plugin**, ports **80 + 443** open.
- DNS for your domain (examples use `kin.example.com`):
  - `A  @  → <vps-ip>`
  - `A  *  → <vps-ip>`  (wildcard, for previews)
  - For TLS option A you also need the domain in **Cloudflare** (for the DNS-01 token); for
    option B, set both records **proxied** (orange).

### 2. Get the code + secrets
```bash
git clone https://github.com/deeptoai-com/kin.git && cd kin
mkdir -p ~/kin-deploy && chmod 700 ~/kin-deploy
cat > ~/kin-deploy/secrets.env <<'EOF'
APP_HOSTNAME=kin.example.com
APP_NAME=kin
# Unique per host; volume names derive from it.
APP_NAME_SANITIZED=kin
POSTGRES_USER=kin
POSTGRES_PASSWORD=__FILL__
POSTGRES_DB=kin
MINIO_ROOT_USER=kin
MINIO_ROOT_PASSWORD=__FILL__
MINIO_BUCKET=kin-files
MEILI_MASTER_KEY=__FILL__
BETTER_AUTH_SECRET=__FILL__
JOBS_SECRET=__FILL__
KIN_SECRET_KEY=__FILL__
# TLS option A (Let's Encrypt DNS-01):
ACME_EMAIL=you@example.com
CF_DNS_API_TOKEN=__cloudflare_token_Zone_Read_DNS_Edit__
# Online auto-update (directory mount avoids broken single-file binds after edits)
UPDATER_TOKEN=__FILL__
UPDATER_PROD_ENV_DIR=/home/you/kin-deploy
UPDATER_COMPOSE_ENV_FILE=/run/updater/envd/secrets.env
# LLM gateway (ARK / Volcengine) — Bearer; do NOT set ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN=ark-your-key
ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/coding
ANTHROPIC_MODEL=glm-5.1
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.1
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.1
ANTHROPIC_DEFAULT_HAIKU_MODEL=doubao-seed-2.0-lite
CLAUDE_CODE_SUBAGENT_MODEL=glm-5.1
OXY_MODELS_SEED='{"default":"default/glm-5.1","connections":[{"id":"default","label":"Default","baseUrl":"https://ark.cn-beijing.volces.com/api/coding","authStyle":"bearer","tokenEnv":"ANTHROPIC_AUTH_TOKEN"}],"models":[{"id":"default/glm-5.1","label":"glm-5.1","connection":"default","model":"glm-5.1","enabled":true,"isDefault":true,"tags":["chat"]}]}'
ENABLE_EMAIL_VERIFICATION=false
EOF
chmod 600 ~/kin-deploy/secrets.env
for k in POSTGRES_PASSWORD MINIO_ROOT_PASSWORD MEILI_MASTER_KEY BETTER_AUTH_SECRET JOBS_SECRET KIN_SECRET_KEY UPDATER_TOKEN; do
  sed -i "s|^$k=__FILL__|$k=$(openssl rand -hex 32)|" ~/kin-deploy/secrets.env
done
# then edit secrets.env: real ANTHROPIC_AUTH_TOKEN, ACME_EMAIL, CF_DNS_API_TOKEN, APP_HOSTNAME,
# UPDATER_PROD_ENV_DIR, and model ids/base URL.
```

### 3. Image — pull (default) or build on the VPS
Default pulls `ghcr.io/deeptoai-com/kin/app:latest` (prebuilt multi-arch). To build on the VPS
instead (needs ≥16 GB RAM): `docker build -t kin:local .` then set
`APP_IMAGE=kin APP_TAG=local APP_PULL_POLICY=never`.

### 4. Bring it up
```bash
docker compose --env-file ~/kin-deploy/secrets.env -f docker-compose.prod.yml -p kin up -d
```
Traefik obtains the wildcard cert via DNS-01 on first boot. The compose pins ACME SOA lookups
to public resolvers (`1.1.1.1`, `8.8.8.8`) so host/Docker DNS quirks do not block Cloudflare
zone discovery. Watch:
`docker logs ${APP_NAME_SANITIZED}-traefik 2>&1 | grep -i acme`.

### 5. Verify
```bash
set -a; . ~/kin-deploy/secrets.env; set +a
docker compose --env-file ~/kin-deploy/secrets.env -f docker-compose.prod.yml -p kin ps
curl -sS -o /dev/null -w '%{http_code}\n' https://$APP_HOSTNAME/health   # → 200
docker exec ${APP_NAME}-app sh -c 'unshare -Urn echo userns-ok'         # → userns-ok (sandbox)
```
Do not use `curl -k` as the success check; that can hide Traefik's default self-signed
certificate. Your browser should show a valid HTTPS certificate for both `<domain>` and
`*.<domain>`.

Then open `https://<domain>`, sign in, ask for a small web app → **运行预览 / Run preview** →
it loads at `https://<id>.<domain>`. (Optional speed-up: `bash infra/preview/warm-cache.sh`.)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Installer stops at Cloudflare preflight | The token is active but cannot read zones from this server. Give it Zone:Read + DNS:Edit on the zone and remove/fix any Client IP restriction. |
| No cert / `https` fails | `docker logs <stack>-traefik \| grep -i acme`. DNS-01 needs `CF_DNS_API_TOKEN` (Zone:Read + DNS:Edit) + the domain on Cloudflare. Wildcard requires DNS-01 (not HTTP-01). If logs mention SOA/SERVFAIL/timeouts, confirm your compose includes the ACME resolver pin above. |
| You changed `CF_DNS_API_TOKEN`, but cert issuance still uses the old token | Recreate Traefik so the container reloads env: `docker compose --env-file ~/kin-deploy/secrets.env -f docker-compose.prod.yml -p kin up -d --force-recreate traefik`. |
| Preview subdomain → cert warning | The wildcard covers `*.<domain>` (one level only). Previews are single-level `<id>.<domain>` by design. |
| Preview opens but **404** | Needs the Traefik **v3 `HostRegexp`** fix — this compose has it. |
| migrate `28P01` | `APP_NAME_SANITIZED` collided with an old stack's volume → set a unique one. |
| Build OOM on the VPS | Don't build on a small box — pull from GHCR (default). Building needs ≥16 GB. |
| Chat auth/model error | `ANTHROPIC_AUTH_TOKEN` set, `ANTHROPIC_API_KEY` **unset**. |

---

## Notes
- This path grants the app the privileges preview + sandbox need (`seccomp/apparmor=unconfined`,
  `NET_ADMIN`) — fine on a VPS you control.
- Backups: the stateful volumes are `${APP_NAME_SANITIZED}-{data,claude-sessions,minio-data,meili-data}`
  (same `docker run --rm -v … tar` recipe as [mac-mini.md](mac-mini.md#operations)).
- All three paths run the **same images + app**; only the edge (proxy / TLS / DNS) differs.
