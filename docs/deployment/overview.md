# Deployment Overview

> **Architecture stance (read this first).**
> **Kin is a standard single-node Docker Compose application. It does NOT require
> Docker Swarm, Kubernetes, or any cluster orchestrator.** Every service (Postgres,
> Redis, MinIO, Meilisearch, the app, the worker, the preview controller, the `parser`
> and `updater` sidecars) is a plain Docker container. You can run the whole thing with
> `docker compose up` on one host.
>
> Kin ships **prebuilt multi-arch (amd64 + arm64) images on GHCR**
> (`ghcr.io/deeptoai-com/kin/{app,parser,updater}`) — deployment **pulls** them, it does
> not build the heavy app on the target host. Verified: the full stack — including the
> Phase C preview engine — runs on plain Docker (no Swarm).

---

## The two supported paths

| Path | Who it's for | What you manage | Compose file |
|---|---|---|---|
| **A. VPS (public-IP host)** | **Anyone self-hosting on a VPS / their own box with a public IP. Recommended baseline.** | The host + a reverse proxy (Traefik, bundled) | `docker-compose.prod.yml` (via `scripts/install-vps.sh`) |
| **B. Cloudflare Tunnel (Mac / workstation / behind NAT)** | A dev box, home server, or workstation with **no public inbound** — full-feature self-host with the least infra | The host only (TLS + DNS handled by Cloudflare; tunnel is outbound-only) | `docker-compose.tunnel.yml` |

Both run the **same images and the same app**. They differ only in **who runs the
reverse proxy / TLS / DNS**:

- **Path A** is driven by the one-command installer `scripts/install-vps.sh`: it installs
  Docker if missing, generates secrets, prompts only for what can't be auto-generated,
  **pulls the prebuilt GHCR images**, and brings up `docker-compose.prod.yml` behind a
  **bundled Traefik** with **Let's Encrypt** (DNS-01 via Cloudflare → wildcard cert). You
  bring a domain + a wildcard DNS record (for previews). The installer treats a trusted
  HTTPS certificate as part of success, so DNS-01 failures do not look like a good deploy.
- **Path B** is driven by `scripts/install-tunnel.sh`: it generates the production env,
  decodes a Cloudflare Tunnel token into `infra/tunnel/`, pulls the prebuilt GHCR images, and
  starts `docker-compose.tunnel.yml`. It bundles Traefik (like A) plus a **`cloudflared`**
  container that opens an *outbound* tunnel to Cloudflare — so the host needs **no public IP and
  no open ports**. Cloudflare terminates TLS at the edge and forwards both the app host and every
  preview subdomain to the bundled Traefik. Ideal for a Mac / workstation or anything behind NAT,
  and gives the **full** feature set (preview + sandbox) — a self-managed host grants the elevated
  container privileges (`seccomp`/`apparmor=unconfined`, `NET_ADMIN`) that a hardened managed PaaS
  may restrict.

> **Online auto-update.** Once a stack is running, an **admin** sees an **update** entry in
> the sidebar when a newer image is published. One click runs the full apply pipeline — pull →
> migrate → recreate worker → recreate app → health-gate → auto-rollback on failure — executed
> by a dedicated `updater` sidecar (it never recreates itself). The apply is admin-gated and
> token-authenticated.
>
> **Mounting the prod env into the updater.** The updater runs `docker compose` against the
> live stack, so it needs the **full production env** (secrets + `APP_NAME` / `APP_NAME_SANITIZED`
> / `RAG_ENABLED` / … ) for `${...}` interpolation. Provide it one of two ways:
>
> - **Recommended — directory mount.** Point `UPDATER_PROD_ENV_DIR` at the **host directory**
>   holding your env file and set `UPDATER_COMPOSE_ENV_FILE=/run/updater/envd/<filename>`. A
>   directory bind survives the host file being **replaced** — an editor or `sed -i` saves by
>   swapping the file's inode, which silently breaks a single-*file* bind until the container is
>   recreated (most visible on macOS / OrbStack).
> - **Legacy — single-file mount.** `UPDATER_PROD_ENV_FILE=/abs/host/prod.env` still works
>   (back-compat, nothing to change for existing deploys), but is inode-fragile per above.
>
> **Symptom of a broken env mount:** clicking update (or the pre-flight service check) fails with
> `error while interpolating services.app.environment.ANTHROPIC_AUTH_TOKEN: required variable
> ANTHROPIC_AUTH_TOKEN is missing a value`. The updater couldn't read the env file, so its inner
> `docker compose` had no values to substitute. **Fix:** recreate just the updater so the mount
> re-attaches (and switch to the directory mount to prevent recurrence):
>
> ```bash
> docker compose -p <project> -f <compose-file> up -d --no-deps --force-recreate updater
> ```

> **Optional:** a **Dokploy** path ([`docker-compose.dokploy.yml`](../../docker-compose.dokploy.yml),
> [dokploy.md](dokploy.md)) for users who already run a Dokploy panel — production runs on the
> **VPS** and **tunnel** paths above, not Dokploy.

---

## What the preview feature needs (both paths)

The Phase C "real preview" runs each multi-file app in its own sandbox container and serves
it on a **wildcard subdomain** (`<id>.<your-domain>`) behind the reverse proxy, gated by a
one-time-token → cookie forward-auth. So both paths require:

1. A **reverse proxy that reads container labels** (Traefik) — bundled in both paths.
2. A **wildcard DNS record** `*.<your-domain>` → the host.
3. A **TLS cert that covers the wildcard** (single-level `*.<domain>`; see the per-path guides).

The preview controller is the only component that talks to the Docker socket; it creates and
tears down preview containers via the Docker API (plain `docker`, no Swarm).

---

## Pick your guide

- **Path A — [VPS one-command install](../../scripts/install-vps.sh)** ← start here if you're
  self-hosting on a public-IP box. Background + manual variant: [docker-compose.md](docker-compose.md).
- **Path B — [Cloudflare Tunnel one-command install](tunnel.md)** ← Mac / workstation / home server / behind NAT.
  - **[Mac mini, from scratch](mac-mini.md)** ← a complete, linear recipe for Path B on a
    fresh Apple-Silicon Mac (day-2 operations).
- **Legacy — [Dokploy](dokploy.md)** ← kept for reference; not the production path.

## Common requirements

- A Linux host (Path A) or a Mac / workstation (Path B) with Docker + the Compose plugin.
- A domain you control + DNS access for the app host and the preview wildcard.
  - Path A needs a Cloudflare DNS API token with Zone:Read + DNS:Edit for Let's Encrypt DNS-01.
  - Path B needs a Cloudflare Tunnel token. If you use Cloudflare Universal SSL on a full zone,
    choose a hostname/certificate plan that covers both `APP_HOSTNAME` and `*.APP_HOSTNAME`.
- Secrets: Postgres/MinIO/Meili passwords, `BETTER_AUTH_SECRET`, and an LLM gateway key
  (ARK `ANTHROPIC_AUTH_TOKEN` by default). The installers auto-generate datastore/auth secrets,
  `KIN_SECRET_KEY`, `UPDATER_TOKEN`, and the model registry seed; see each guide's env section.
