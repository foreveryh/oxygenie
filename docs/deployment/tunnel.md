# Path B — Cloudflare Tunnel (workstation / home server / behind NAT)

Run the **full** Kin stack — including the Phase C **preview engine** and the **code
sandbox** — on a single machine that has **no public inbound** (a dev Mac, a home server,
any box behind NAT/CGNAT), and expose it on your domain through a **Cloudflare Tunnel**.

- **No public IP, no port-forwarding, no open ports.** `cloudflared` makes an *outbound*
  connection to Cloudflare; traffic comes back down that tunnel.
- **TLS is terminated at the Cloudflare edge** — the tunnel→Traefik hop is plain HTTP, so
  there are no certs to manage on the host. For preview subdomains, make sure Cloudflare's edge
  certificate covers both `APP_HOSTNAME` and `*.APP_HOSTNAME` (details below).
- This path gives you the elevated container privileges (`seccomp=unconfined`,
  `apparmor=unconfined`, `cap_add: NET_ADMIN`) that preview + sandbox need and that a hardened
  managed PaaS may not allow — so it's the fastest way to a **full-feature** trial.

```
Cloudflare edge (TLS, *.kin.example.com)
  └─ cloudflared  (outbound QUIC tunnel; no inbound ports)
        └─ Traefik (:80, Host routing, reads container labels)
              ├─ kin.example.com        → app (5000) ;  /ws → ws-server (3001)
              └─ <id>.kin.example.com   → preview sandbox container (4173), forward-auth gated
```

**Installer:** [`scripts/install-tunnel.sh`](../../scripts/install-tunnel.sh) ·
**Compose file:** [`docker-compose.tunnel.yml`](../../docker-compose.tunnel.yml) ·
**configs:** [`infra/tunnel/`](../../infra/tunnel/)

> This is **Path A + a tunnel**: the same bundled Traefik, plus a `cloudflared` container and
> a small `dockerproxy` shim for modern Docker API compatibility. On a normal cloud VPS with a
> public IP, prefer [Path A](docker-compose.md) (Let's Encrypt / your own certs) — you don't need
> the tunnel.

---

## Recommended: one-command install

From a fresh clone:

```bash
git clone https://github.com/deeptoai-com/kin.git && cd kin
bash scripts/install-tunnel.sh
```

The installer prompts for:

- `APP_HOSTNAME` — the public hostname for Kin.
- `CLOUDFLARED_TUNNEL_TOKEN` — copied from Cloudflare Zero Trust.
- `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` — your model gateway.

It then generates `~/kin-deploy/secrets.env`, writes `infra/tunnel/config.yml` and
`infra/tunnel/credentials.json`, starts the stack, verifies the local Traefik route, and prints
the two Cloudflare CNAME records to add.

Non-interactive:

```bash
APP_HOSTNAME=example.com \
CLOUDFLARED_TUNNEL_TOKEN='eyJ...' \
ANTHROPIC_AUTH_TOKEN='...' \
ANTHROPIC_BASE_URL='https://ark.cn-beijing.volces.com/api/coding' \
ANTHROPIC_MODEL='glm-5.1' \
bash scripts/install-tunnel.sh --yes
```

If `infra/tunnel/config.yml` or `credentials.json` already exists, the script refuses to replace
it. To rotate/recreate the tunnel files intentionally, pass `--force-tunnel`.

---

## Critical invariants (get any wrong → it won't serve)

1. **DNS is two proxied CNAMEs to the tunnel** — `APP_HOSTNAME` **and** `*.APP_HOSTNAME`, both
   → `<TUNNEL_ID>.cfargotunnel.com` (orange cloud ON). Preview URLs are single-label children
   of `APP_HOSTNAME`, for example `<id>.example.com` when `APP_HOSTNAME=example.com`.
   Cloudflare Universal SSL on a full zone covers the zone apex and first-level subdomains only
   ([Cloudflare docs](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/));
   if `APP_HOSTNAME=kin.example.com`, previews become `<id>.kin.example.com` and need Total TLS,
   an Advanced Certificate for `*.kin.example.com`, a custom edge cert, or a CNAME/subdomain setup
   that provisions certificates for deeper subdomains. Wildcard certificates cover one label per
   wildcard ([Cloudflare docs](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/#wildcard-coverage)).
2. **Ingress lives in `infra/tunnel/config.yml`, not the dashboard.** Do **not** add Public
   Hostnames in the Zero-Trust UI — define `APP_HOSTNAME` + `*.APP_HOSTNAME` → `http://traefik:80`
   in `config.yml` so the wildcard works. (Dashboard-managed ingress can't express a wildcard.)
3. **`credentials.json` is a secret** (it holds the tunnel secret). It's gitignored — never commit it.
4. **Image pulls from GHCR by default** — `docker-compose.tunnel.yml` defaults to the prebuilt
   **multi-arch** image `ghcr.io/deeptoai-com/kin/app` (`APP_PULL_POLICY=always`), and a Mac
   uses the native **arm64** variant automatically. To build locally instead (no GHCR pull), set
   `APP_IMAGE=kin APP_TAG=local APP_PULL_POLICY=never`, build `kin:local`, and overlay
   `-f docker-compose.build.yml` so app + parser use their local `build:` stanza.
5. **ARK auth** uses `ANTHROPIC_AUTH_TOKEN` (Bearer) — do **not** set `ANTHROPIC_API_KEY`
   (setting it makes the SDK switch to `x-api-key` and ARK rejects it). Same as every other path.
6. **The `dockerproxy` shim is required on OrbStack/Docker Desktop AND on Docker 28/29+.**
   Traefik's docker provider pins API `v1.24`; a daemon whose minimum is `1.40` rejects it →
   `"client version 1.24 is too old"`. This hits **macOS (OrbStack/Docker Desktop)** *and*
   **modern Docker on any OS** (Docker 28/29 raised the minimum to 1.40 — verified on Docker 29
   / Ubuntu). `dockerproxy` (nginx) rewrites `/vX.Y/...` → `/v1.44/...`. Only **old Linux Docker
   (≤27)** can skip it and point Traefik at the socket directly (see the bottom).

---

## Manual steps (what the installer automates)

### 1. Create the tunnel + copy its token
Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → *Cloudflared* →
name it → copy the **token** (`eyJ...`). Do **not** add Public Hostnames here.

### 2. Generate credentials + set the tunnel id
From `infra/tunnel/` (both `config.yml` and `credentials.json` are gitignored — per-deploy):
```bash
TOKEN='eyJ...'   # paste your tunnel token
APP_HOSTNAME=kin.example.com
TID=$(python3 - "$TOKEN" "$APP_HOSTNAME" <<'PY'
import base64, json, pathlib, sys
token, host = sys.argv[1:3]
token += "=" * ((4 - len(token) % 4) % 4)
d = json.loads(base64.urlsafe_b64decode(token.encode()))
pathlib.Path("credentials.json").write_text(json.dumps({"AccountTag":d["a"],"TunnelID":d["t"],"TunnelSecret":d["s"]}) + "\n")
pathlib.Path("config.yml").write_text(f"""tunnel: {d['t']}
credentials-file: /etc/cloudflared/credentials.json
ingress:
  - hostname: {host}
    service: http://traefik:80
  - hostname: "*.{host}"
    service: http://traefik:80
  - service: http_status:404
""")
print(d["t"])
PY
)
echo "Tunnel ID: $TID"   # you need this for DNS in step 3
```
This writes `credentials.json` (the secret) and `config.yml`.

### 3. DNS (Cloudflare, both **proxied / orange**)
Point both records at the tunnel (replace `<TID>` with the id from step 2). For the lowest-friction
free Universal SSL path, make `APP_HOSTNAME` your Cloudflare zone apex, for example `example.com`;
then previews are `*.example.com` and are covered by Universal SSL. If you prefer
`kin.example.com`, also enable edge certificate coverage for `*.kin.example.com`.

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `APP_HOSTNAME` | `<TID>.cfargotunnel.com` | **Proxied** |
| CNAME | `*.APP_HOSTNAME` | `<TID>.cfargotunnel.com` | **Proxied** |

### 4. Secrets (outside the repo)
Keep secrets in `~/kin-deploy/secrets.env` (chmod 600 — **never** in the repo / `.env`).
Minimum:
```bash
APP_HOSTNAME=kin.example.com
APP_NAME=kin
# Must be globally unique among your stacks; volume names derive from it.
APP_NAME_SANITIZED=kin
APP_IMAGE=ghcr.io/deeptoai-com/kin/app
APP_TAG=latest
APP_PULL_POLICY=always
# Postgres / MinIO / Meili / auth
POSTGRES_USER=kin POSTGRES_PASSWORD=... POSTGRES_DB=kin
MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=...
MINIO_BUCKET=kin-files
# Generate these with: openssl rand -hex 32
MEILI_MASTER_KEY=...
BETTER_AUTH_SECRET=...
JOBS_SECRET=...
KIN_SECRET_KEY=...
# Online auto-update (directory mount avoids broken single-file binds after edits)
UPDATER_TOKEN=...
UPDATER_PROD_ENV_DIR=/Users/you/kin-deploy
UPDATER_COMPOSE_ENV_FILE=/run/updater/envd/secrets.env
# LLM gateway (ARK / Volcengine) — Bearer auth, NOT ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN=ark-xxxxxxxx
ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/coding
ANTHROPIC_MODEL=glm-5.1
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.1
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.1
ANTHROPIC_DEFAULT_HAIKU_MODEL=doubao-seed-2.0-lite
CLAUDE_CODE_SUBAGENT_MODEL=glm-5.1
OXY_MODELS_SEED='{"default":"default/glm-5.1","connections":[{"id":"default","label":"Default","baseUrl":"https://ark.cn-beijing.volces.com/api/coding","authStyle":"bearer","tokenEnv":"ANTHROPIC_AUTH_TOKEN"}],"models":[{"id":"default/glm-5.1","label":"glm-5.1","connection":"default","model":"glm-5.1","enabled":true,"isDefault":true,"tags":["chat"]}]}'
ENABLE_EMAIL_VERIFICATION=false
```

### 5. Bring the stack up (pulls the prebuilt multi-arch image)
```bash
docker compose --env-file ~/kin-deploy/secrets.env -f docker-compose.tunnel.yml -p kin up -d
```

> **Build locally instead** (no GHCR pull) — only if you want to run your own build:
> ```bash
> docker build -t kin:local .                               # native arm64 on a Mac
> export APP_IMAGE=kin APP_TAG=local APP_PULL_POLICY=never
> docker compose -f docker-compose.tunnel.yml -f docker-compose.build.yml -p kin up -d
> ```

### 6. Verify the stack locally (before trusting DNS)
All of these run **inside the host** and prove each hop without going out to Cloudflare.
`fetch()` from Node ignores a manual `Host` header, so test routing with `wget --header`:
```bash
set -a; . ~/kin-deploy/secrets.env; set +a

# (a) everything up + db/redis/minio/meili healthy
docker compose --env-file ~/kin-deploy/secrets.env -f docker-compose.tunnel.yml -p kin ps

# (b) cloudflared connected to the edge (expect 4x "Registered tunnel connection")
docker logs ${APP_NAME_SANITIZED}-cloudflared 2>&1 | grep "Registered tunnel connection"

# (c) Traefik routes the app — through the proxy container which has busybox wget
TIP=$(docker inspect ${APP_NAME_SANITIZED}-traefik -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
docker exec ${APP_NAME_SANITIZED}-dockerproxy sh -c \
  "wget -qS -O /dev/null --header='Host: $APP_HOSTNAME' http://$TIP/health 2>&1 | grep HTTP/"   # → 200
docker exec ${APP_NAME_SANITIZED}-dockerproxy sh -c \
  "wget -qS -O /dev/null --header='Host: $APP_HOSTNAME' http://$TIP/ws/agent 2>&1 | grep HTTP/" # → 426

# (d) sandbox is viable (user + net namespace must succeed in the app container)
docker exec kin-app sh -c 'unshare -Urn echo userns-ok'   # → userns-ok
```
Then open `https://$APP_HOSTNAME` in a browser (DNS must be live from step 3).
Register the first account; self-host installers set `ENABLE_EMAIL_VERIFICATION=false` until you
configure SMTP/Resend, so first run is not blocked by an email round-trip.

### 7. Try the full preview + sandbox
In the chat, ask for a small multi-file web app, click **运行预览 / Run preview**. The
preview-controller spins up a sandbox container, Traefik picks it up by label, and you land on
`https://<id>.<APP_HOSTNAME>` after the one-time-token → cookie hand-off. Code execution (Python
etc.) runs in the same sandbox.

### 8. (Optional) Pre-warm the dependency cache — faster first preview
Every preview container mounts a **shared package-manager cache** (`/pm-cache`, the
`oxy-preview-pm-cache` volume) and points npm/pnpm/yarn at it, so installs reuse downloads
instead of re-fetching every run (measured: cold ≈ 15s → warm ≈ 4s for a React+Vite app).
The cache self-warms as you use it; to seed the common frameworks up front so even the very
first preview is fast, run once:
```bash
bash infra/preview/warm-cache.sh           # react/react-dom/vite/vue/typescript/tailwind…
# add more:  PREVIEW_WARM_DEPS="svelte @sveltejs/vite-plugin-svelte" bash infra/preview/warm-cache.sh
```
This applies to **all** deploy paths (the cache lives in the preview controller, not the proxy).

---

## Troubleshooting (issues actually hit bringing this up on macOS/OrbStack)

| Symptom | Cause | Fix |
|---|---|---|
| Traefik log: `client version 1.24 is too old. Minimum supported API version is 1.40` | OrbStack/Docker Desktop and Docker 28/29+ reject Traefik's pinned API version | The bundled **`dockerproxy`** (nginx) rewrites the version prefix. It's already wired in `docker-compose.tunnel.yml`; keep it unless you are on old Linux Docker (≤27). |
| App opens, but preview subdomain has a TLS certificate error | Cloudflare edge certificate does not cover `*.APP_HOSTNAME` | Use the zone apex as `APP_HOSTNAME` for free Universal SSL, or enable Total TLS / Advanced Certificate / custom certificate for `*.APP_HOSTNAME`. |
| `dockerproxy` log: `"user" directive is duplicate in /etc/nginx/nginx.conf` | Overriding `user` via `nginx -g` while the image's `nginx.conf` already sets `user nginx;` | We ship a **full** `infra/tunnel/nginx.conf` (with `user root;`) mounted at `/etc/nginx/nginx.conf` — no `-g` override. |
| `dockerproxy` → 502 `connect() to unix:/var/run/docker.sock failed (13: Permission denied)` | nginx workers ran as `nginx`; the socket is `root:root 0660` | `nginx.conf` sets `user root;` so workers can read the socket. |
| Traefik provider: `lookup dockerproxy ... no such host` | transient — `dockerproxy` was mid-recreate | Wait a few seconds / `up -d` again; Traefik retries automatically. |
| App routing returns **404** from your own `fetch()` test but the browser works | Node/undici **ignores a manual `Host` header** and sends `Host: <url-host>` → matches no router | Test with `wget --header='Host: $APP_HOSTNAME'` (step 6c), not `fetch`. |
| Preview subdomain → **401** | Expected before auth: Traefik matched the preview router and ran forward-auth; no one-time token yet | Reach the preview through the app's **Run preview** button (it mints the token), not by hand. |
| `cloudflared` keeps reconnecting / `Unauthorized` | bad/[]rotated token or `credentials.json` mismatch | Re-run step 2 with a fresh token; confirm `tunnel:` id in `config.yml` matches `credentials.json`. |
| Site unreachable but stack is up | the host went to sleep / offline | This is a workstation path — the box must stay **on + online** for the site to be reachable. |

---

## Old Linux Docker (≤27): you may drop `dockerproxy`

The `dockerproxy` shim exists because Traefik's docker provider pins API `v1.24`, which daemons
with a minimum of `1.40` reject — that's **macOS (OrbStack/Docker Desktop)** *and* **Docker
28/29+ on any OS**. Only on **older Linux Docker (≤27)** can you delete the `dockerproxy` service
and point Traefik at the socket directly:

```yaml
  traefik:
    # remove:  - "--providers.docker.endpoint=tcp://dockerproxy:2375"
    # remove:  depends_on: [dockerproxy]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

Everything else (cloudflared, the bundled Traefik, labels, DNS) is identical.

---

## Notes

- **The host must stay on + online.** A Mac mini left on works well; a laptop that sleeps
  drops the tunnel. For an always-on box with a public IP, use
  [Path A — VPS](docker-compose.md) (the [one-command installer](../../scripts/install-vps.sh)).
- **`credentials.json` is a secret.** Gitignored; rotate the tunnel if it ever leaks.
- **Same images, same app** as the VPS path — only the edge (Cloudflare tunnel vs. your own
  proxy/TLS) differs.
