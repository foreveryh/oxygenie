---
title: "Dokploy Deployment — multi-stage Docker, GHCR, Traefik subdomains, and Cloudflare Origin CA"
slug: 18-dokploy-deploy
date: 2026-06-07
keywords: [Dokploy, Docker, GHCR, Traefik, Cloudflare Origin CA, CI/CD]
---

# Dokploy Deployment — multi-stage Docker, GHCR, Traefik subdomains, and Cloudflare Origin CA

All of Kin's runtime components must be deployable on a 16 GB VPS with one-click redeploys. This lesson describes the deployment chain: multi-stage Docker image, GitHub Actions pre-build on amd64, GHCR push, Dokploy Compose orchestration, Traefik subdomain routing, and Cloudflare Origin CA certificates.

## The problem

Five constraints must be satisfied:

1. One-click redeploys from a git push.
2. The build must not OOM on the free CI runner (about 7 GB).
3. The build architecture must match the production amd64 host.
4. Each preview must be reachable on a first-level subdomain with HTTPS.
5. About ten services (Traefik, Postgres, Redis, MinIO, Meilisearch, app, ws-server, migrations, worker, preview-controller) must be orchestrated together.

## Why the naive options fail

- **Build on the Dokploy host directly**: SSR builds consume too much memory and compete with the running services. It is also slow and wasteful.
- **Build locally on a Mac**: produces an ARM64 image that will not run on the amd64 production host.
- **Dynamic Let's Encrypt for preview subdomains**: Cloudflare Full(Strict) mode blocks HTTP-01 validation, and free-tier wildcards only cover one level.
- **Keep Playwright and LibreOffice in the image**: adds roughly 2 GB to the image, increasing CI build memory and disk pressure.
- **Use Kubernetes**: unnecessary complexity for a single-machine, ~50-session target.

## The core design

> **Pre-build the amd64 image in GitHub Actions, push to GHCR, and have Dokploy pull it with `pull_policy: always`. Use a multi-stage Dockerfile slimmed to ~1.5 GB. Orchestrate with a single Dokploy Compose file. Route subdomains through Traefik using a single Cloudflare Origin CA certificate.**

- **Multi-stage Dockerfile**: builder stage runs Vite build with 8 GB memory; runner stage installs only Python, bubblewrap, socat, pandoc, and runs as a non-root `nodejs` user. Playwright and LibreOffice are removed, reducing the image from ~3.5 GB to ~1.5 GB.
- **GitHub Actions amd64 build**: `.github/workflows/build.yml` builds on `linux/amd64` and pushes to `ghcr.io/.../app:{SHA}` and `:latest`. This avoids both host-memory pressure and architecture mismatch.
- **Dokploy Compose with `pull_policy: always`**: all services using the app image must set `pull_policy: always`. The default `missing` will not replace a local image when a newer digest is published, breaking one-click redeploy.
- **Traefik + Cloudflare Origin CA**: preview subdomains use Traefik `HostRegexp` with a single Origin CA certificate that covers `*.oxygenie.cc`. This avoids both HTTP-01 validation problems and the single-wildcard-level limit.
- **Unified start script**: `start-production.mjs` launches both Nitro (port 5000) and the WebSocket server (port 3001) inside the same container, so Compose only needs to manage one app service.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `Dockerfile` | ~L2–54 / L55–148 | builder (Vite build with 8 GB) / runner (non-root, Python, sandbox tools) |
| `.github/workflows/ci.yml` | ~L43–72 | lint/unit hard gates, integration non-blocking, build with 8 GB |
| `.github/workflows/build.yml` | ~L21–44 | amd64 build → GHCR `:SHA` + `:latest` |
| `docker-compose.dokploy.yml` | ~L20–21 / L117 / L396–421 | `pull_policy: always`, `ANTHROPIC_AUTH_TOKEN`, preview-controller |
| `start-production.mjs` | — | Nitro + ws-server in one container |

## The counter-intuitive conclusion

> **Half the engineering of self-hosting an agent is working around the quirks of CDN and build environments.**

The Dockerfile is not the hard part. The hard parts are discovered at deploy time: Cloudflare's certificate limits, CI memory limits, the architecture mismatch between developer laptops and production, and Compose's default pull policy. The value of a deployment is not the running container but the repeatable Compose and workflow files that encode the discovered constraints.

## Production pitfalls

- **Do not set `DATABASE_URL` in `.env` when using Docker Compose**. Compose constructs `DATABASE_URL` from `POSTGRES_*`. A manually set `DATABASE_URL` will point to `localhost` and break migrations.
- **Traefik v3 `HostRegexp` syntax differs from v2**. YAML escaping and compose interpolation (`$` → `$$`) are also easy to get wrong. Test with a fixed subdomain before enabling the wildcard pattern.
- **Use only `ANTHROPIC_AUTH_TOKEN` with ARK**. `ANTHROPIC_API_KEY` changes the authentication header and causes 401s.
- **A private GHCR package requires registry credentials in Dokploy**. Otherwise pulls fail silently with a 403.
- **`depends_on: healthy` does not guarantee DNS resolution for the `db` service**. Migrations must retry until the database is reachable.

## Related Kin documentation

- `Dockerfile` — image build
- `.github/workflows/build.yml` — CI image build
- `docker-compose.dokploy.yml` — production orchestration
- `start-production.mjs` — container startup
- `15-real-preview.md` — preview subdomain and Origin CA
- `docs/deployment/` — deployment guides

## Diagrams

1. `docs/blog/assets/img/18-deploy-pipeline.svg` — CI → GHCR → Dokploy → Traefik
2. `docs/blog/assets/img/18-cf-origin-ca.svg` — Cloudflare Origin CA + first-level wildcard
