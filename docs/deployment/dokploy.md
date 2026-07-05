# Deploy Kin on Dokploy (optional / secondary path)

> **Dokploy is a secondary route.** The two **supported** paths are the
> [one-command VPS installer](../../scripts/install-vps.sh) ([docker-compose.md](docker-compose.md))
> and the [Cloudflare-tunnel stack](tunnel.md). Use Dokploy only if you already run a
> Dokploy panel and specifically want it. This guide is the **validated** recipe (last
> verified working 2026-06); the historical blockers below are already fixed inside
> `docker-compose.dokploy.yml`, so you do **not** need to re-derive them.

## Prerequisites
- A Dokploy server with a public IP and ports 80/443.
- A domain you can point at the server.
- The GHCR images are **public and multi-arch** (`ghcr.io/deeptoai-com/kin/{app,parser}`) —
  Dokploy **pulls** them. Never let Dokploy **build** on the host: the SSR bundle peaks >8 GB and OOM-kills.

## Steps
1. **Create a Compose service** in a Dokploy project.
   - Source = **Git** → repo `https://github.com/deeptoai-com/kin.git`, branch `main`.
   - Compose path = `./docker-compose.dokploy.yml`.
2. **Set environment variables** — copy [`infra/deploy/env.dokploy.example`](../../infra/deploy/env.dokploy.example),
   fill the `CHANGE_ME`s (`openssl rand -hex 24` / `-hex 32`).
   - **`APP_NAME_SANITIZED` must be unique** on a shared host (volume names are global → collision = 28P01).
   - **Do NOT set `DATABASE_URL` or `ANTHROPIC_API_KEY`** (see the example header for why).
   - All four ARK model aliases must resolve to real models on your gateway.
3. **Add the domain** = your `APP_HOSTNAME`.
   - DNS: `A @ → <server-ip>` (Cloudflare **Proxied** / orange cloud).
   - For the in-app **preview** feature, also add `A * → <server-ip>` (single-level wildcard only —
     Cloudflare's free SSL doesn't cover two levels like `*.preview.<domain>`).
   - TLS: Cloudflare **Full** mode terminates at the edge; the origin cert isn't validated, so the
     stack's default cert is fine. (Don't use Let's Encrypt HTTP-01 behind the orange cloud — it's blocked.)
4. **Deploy.**
5. **Smoke test:** `GET /api/health` → `200` · `GET /` → `200` · `GET /ws/agent` → **`426`**
   (426 = the WebSocket server is alive and routed — the agent-chat lifeline).

## Redeploying after pulling new code (avoid a race with CI)

`redeploy` just re-pulls `${APP_TAG:-latest}` from GHCR — it does **not** build anything, and it
does **not** wait for GitHub Actions. If you push to `main` and immediately hit "redeploy", the
`build-image` workflow (multi-arch, ~4-5 min) is very likely still running, so you'll silently
redeploy the **previous** image and think you shipped the new one. Always:

1. Wait for `build-image` to go green for your commit (`gh run list --workflow build-image` or the
   Actions tab).
2. *Then* redeploy.
3. Confirm with `curl https://<your-domain>/api/health` — `version` should equal your commit's full
   SHA. `schemaVersion.inSync` should be `true` (it compares migrations shipped in the image against
   migrations actually applied to your database — a quick way to tell "did my migration really run"
   without shelling into the container).

**Don't run Kin's own online-update sidecar (`updater`) here.** Dokploy already owns this stack's
lifecycle; a second process independently running `docker compose up --force-recreate` against the
same stack will fight Dokploy's own reconciliation. Keep `UPDATER_TOKEN` empty and use Dokploy's
redeploy for updates, per the step above — this is the "what's limited" item below.

## What works / what's limited on Dokploy
- ✅ **Works:** the site, sign-up/login, **Agent chat** (your model gateway), Postgres/Redis/MinIO/Meili,
  conversation-history search, file upload, skills/MCP.
- ⚠️ **RAG (document parsing)** needs the `parser` sidecar, which this compose doesn't include — keep `RAG_ENABLED=false`.
- ⚠️ **Online auto-update** (the `updater`) should stay **off** (`UPDATER_TOKEN=` empty) — Dokploy owns the
  stack lifecycle, so letting the sidecar run `docker compose up` on the same stack fights Dokploy's orchestration.
- ⚠️ **In-app preview / strong sandbox** needs `seccomp=unconfined` + `apparmor=unconfined` + user namespaces.
  A self-managed host can grant these; a restricted PaaS may not, in which case sandboxing degrades to
  env-strip-only (code still runs, isolation is weaker) and live preview may not start. Test before relying on it.

## Hard invariants (baked into the compose — listed so you don't undo them)
1. Pull prebuilt GHCR images (`image:` + `pull_policy: always`); never `build:` on the host.
2. Unique `APP_NAME_SANITIZED` per deploy (global volume names).
3. Don't set a standalone `DATABASE_URL` — the compose builds it from `POSTGRES_*`.
4. ARK uses `ANTHROPIC_AUTH_TOKEN` (Bearer); leave `ANTHROPIC_API_KEY` empty.
5. All four ARK model aliases set.
6. Preview domain is single-level `*.<domain>`; TLS via Cloudflare Full + origin default cert, not Let's Encrypt.
7. `migrate` retries until `db` resolves (Dokploy DNS timing) — already built in.
8. Preview auth route uses Traefik **v3** regex (`HostRegexp(\`^[a-z0-9-]+\.${APP_HOSTNAME}$\`)`) — already in the compose.

> Operational helpers: [`infra/deploy/backup-db.sh`](../../infra/deploy/backup-db.sh) /
> [`restore-db.sh`](../../infra/deploy/restore-db.sh) for Postgres dump/restore.
