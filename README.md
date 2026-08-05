# Kin

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](.github/CODE_OF_CONDUCT.md)
[![Images](https://img.shields.io/badge/images-GHCR%20multi--arch-2496ed.svg)](https://github.com/deeptoai-com/kin/pkgs/container/kin%2Fapp)

**Kin is a self-hosted, single-org, multi-user agent workspace for small teams.** Run a
full desktop-grade AI agent — Skills, MCP, Artifacts, sandboxed code execution, a
document knowledge base (RAG) — on **your own infrastructure**, on the model gateway and
budget you choose. No vendor lock-in. Your **documents, conversations, and audit logs stay
on your servers**; model calls go only to the endpoint **you** choose (which can be your
own / a zero-retention gateway). Kin is API-based and provider-neutral — not air-gapped.

Kin is built for the realistic team case: a trusted circle of colleagues self-hosting one
shared workspace. It is **not** an anonymous public multi-tenant SaaS — security is
defence-in-depth (org-internal user isolation, sandboxing, misuse guards), not a lockdown
against the open internet.

## Product positioning

Kin is the **self-hostable team AI workspace** for sensitive small teams: law firms,
research labs, funds, family offices, studios, and internal teams that want an agent to
work with files, code, documents, previews, and tools without moving the whole workspace
into a vendor SaaS.

| Kin is for | Kin is not |
|------------|------------|
| Trusted teams running one private workspace on their own host | A public multi-tenant chat SaaS |
| Agent work: files, code execution, artifacts, previews, Skills, MCP, RAG | A workflow-builder platform where users must assemble every bot first |
| Provider-neutral model routing through your chosen API endpoint | An air-gapped local-model appliance by default |
| Small teams that care about data ownership, auditability, and deployability | Anonymous internet users or zero-trust hostile tenants |

**Data boundary:** your documents, knowledge base, conversations, audit logs, users, and
runtime state stay on your infrastructure. Model calls send the current inference context
only to the endpoint you configure.

## Highlights

- 🧰 **Skills & MCP** — one-click enable/disable of curated skills and MCP servers; toggles take effect on the next new conversation (the current SDK session does not hot-reload them).
- 👥 **Projects & branch-on-reply** — share sessions with project members; non-owner replies
  fork the conversation so the original stays read-only and attributed.
- 🎨 **Artifacts + live preview sandbox** — generate web pages / docs / React / SVG, and run
  multi-file web apps in a per-session sandbox container on their own subdomain.
- 🐍 **Sandboxed code execution** — isolated per-session runtime for code, data analysis,
  automation.
- 📚 **Document knowledge base (RAG)** — upload PDFs/docs, parsed and embedded into a
  searchable knowledge base scoped by project or user; sessions can narrow retrieval to
  selected knowledge bases. Citations are preserved for the model. (RAG is off by default;
  set `RAG_ENABLED=true` and deploy the parser sidecar.)
- 🔀 **Concurrent sessions / background-continue** — a running conversation keeps going in
  the background while you start another; running sessions are marked in the sidebar
  (ChatGPT/Claude-style).
- 🔎 **Conversation search** — full-text search across message bodies (not just titles),
  jump straight to the matching message.
- ⬆️ **One-click online auto-update** — admins upgrade the running stack from the UI
  (pull → migrate → recreate → health-gate → auto-rollback on failure).
- 🌐 **Bring any model (provider-neutral)** — point Kin at **any Anthropic-compatible
  gateway or your own endpoint**; ARK / Volcengine is just the default. GLM, DeepSeek,
  doubao, GPT, Qwen… whatever your account or gateway exposes; the menu only lists models
  that probe healthy. No lock-in to any single provider.
- 📦 **One-command install** — prebuilt **multi-arch (amd64 + arm64)** images on GHCR; a
  fresh VPS goes from zero to a running, TLS-terminated stack with one script.

## Demo media placeholders

> Launch TODO: replace this section with real images/video before a public GTM push. Detailed
> capture instructions live in **[docs/gtm/media-checklist.md](docs/gtm/media-checklist.md)**.

| Slot | Put final asset at | Capture exactly |
|------|--------------------|-----------------|
| Hero GIF / short silent loop | `docs/gtm/media/kin-hero-agent-preview.gif` | `/agents/c`: ask Kin to build a small multi-file web app, show tool calls, generated files, and **运行预览 / Run preview** reaching a live preview URL. |
| Core screenshot 1 | `docs/gtm/media/01-agent-workspace.png` | `/agents/c`: left conversation with tool-call timeline, right workbench/files, preview-ready state visible. |
| Core screenshot 2 | `docs/gtm/media/02-admin-models.png` | `/admin/models`: healthy model row, default model slots, and the API-key paste/test flow visible. Mask any real key. |
| Core screenshot 3 | `docs/gtm/media/03-canvas-workspace.png` | `/agents/canvas/<canvasId>`: chat + canvas side-by-side with text/image/video nodes and the bottom direct-generation toolbar visible. |
| Core screenshot 4 | `docs/gtm/media/04-online-update.png` | `/admin/updates` or the sidebar update prompt: current build, latest build, and update status visible. |
| 90s product video | Link to YouTube/Loom or `docs/gtm/media/kin-product-demo.mp4` | Start with the private-team workspace promise, then show model setup, an agent run, live preview, admin update, and deployment paths. |
| 5 min install video | Link to YouTube/Loom or `docs/gtm/media/kin-vps-install.mp4` | Fresh VPS install: Cloudflare DNS/token prerequisites, `install-vps.sh`, first admin registration, model health test, first preview. |

## Quick start

> Kin ships **prebuilt multi-arch images** to GHCR
> (`ghcr.io/deeptoai-com/kin/{app,parser,updater}`), so you don't build the heavy app
> locally — the installer just pulls them.

### Choose your deployment path

| Path | Best for | Needs |
|------|----------|-------|
| **A. VPS install** | Production baseline on a Linux host with public inbound traffic | Ubuntu/Debian VPS, ports 80/443, a Cloudflare-managed domain, `A` records for the app host and wildcard previews, model gateway key |
| **B. Tunnel install** | Mac mini, workstation, home server, or any host behind NAT | Docker/OrbStack, a Cloudflare Tunnel token, two proxied CNAME records, model gateway key |
| **C. Local development** | Contributors changing code | Node 22+, pnpm, Docker Compose |

For launch videos and docs, Path A is the cleanest "fresh server to production" story.
Path B is the best "private AI box on a Mac mini / workstation" story.

### Option A — One-command VPS install (public-IP host) ⭐

For a fresh Ubuntu/Debian VPS with a public IP and a domain on Cloudflare. Installs Docker
if missing, generates all datastore/auth secrets, prompts only for what can't be
auto-generated (model-gateway key, domain, Cloudflare DNS token), pulls the images, brings
up the stack behind Traefik + Let's Encrypt, and waits until it serves with a trusted TLS
certificate.

```bash
git clone https://github.com/deeptoai-com/kin.git
cd kin
sudo bash scripts/install-vps.sh            # interactive
# or, fully non-interactive:
#   sudo APP_HOSTNAME=kin.example.com ANTHROPIC_AUTH_TOKEN=... ANTHROPIC_BASE_URL=... \
#        ANTHROPIC_MODEL=... ACME_EMAIL=you@example.com CF_DNS_API_TOKEN=... \
#        bash scripts/install-vps.sh --yes
```

When it finishes, open `https://<your-domain>` and register the first account. The browser
should show a valid HTTPS certificate, not a warning page.

### Option B — Mac / workstation / behind NAT (OrbStack + Cloudflare Tunnel)

No public IP needed: a `cloudflared` container opens an outbound tunnel to Cloudflare, so
the same images run on your Mac (OrbStack/Docker Desktop) or home server and are reachable
on your domain. See **[docs/deployment/tunnel.md](docs/deployment/tunnel.md)**.

```bash
git clone https://github.com/deeptoai-com/kin.git && cd kin
bash scripts/install-tunnel.sh               # interactive
# or, fully non-interactive:
#   APP_HOSTNAME=example.com CLOUDFLARED_TUNNEL_TOKEN=... ANTHROPIC_AUTH_TOKEN=... \
#   ANTHROPIC_BASE_URL=... ANTHROPIC_MODEL=... bash scripts/install-tunnel.sh --yes
```

The script generates `~/kin-deploy/secrets.env`, writes the per-deploy tunnel files under
`infra/tunnel/`, starts the stack, and prints the two Cloudflare CNAME records you must add.

### Option C — Local development

Runs the dependency services (Postgres, Redis, MinIO, Meilisearch) in Docker and the app as
a local Node process. See **[Development](#development)** and `CLAUDE.md`.

```bash
git clone https://github.com/deeptoai-com/kin.git && cd kin
pnpm install
scripts/local-prod.sh --build                # builds + serves on http://127.0.0.1:3100
```

## First-run smoke test

After any production install, run this once before inviting a team:

1. Open `https://<your-domain>` and register the first account. It becomes the system admin.
2. Open `/admin/models`, confirm a default model exists, paste/test the API key if needed,
   and wait for model health to show healthy.
3. Open `/agents/c`, select the healthy model, and send a tiny prompt.
4. Ask Kin to create a small multi-file web app, then click **运行预览 / Run preview** and
   confirm it opens at `https://<preview-id>.<your-domain>/`.
5. Open `/admin/updates` and confirm the updater can check the current image status.
6. Invite a second user only after the model, preview, and update checks are green.

## Online auto-update

Once running, an **admin** sees an **update** entry in the sidebar when a newer image is
published. One click runs the full apply pipeline, executed by a dedicated `updater`
sidecar (it never recreates itself — no self-suicide):

```
pull new image → run migrations → recreate worker → recreate app → health-gate → done
                                                            └─ on failure: auto-rollback to last good image
```

The update check compares the running build SHA to the latest published image; the apply is
admin-gated and token-authenticated. The updater needs the **production env mounted** so its
inner `docker compose` can resolve `${...}` — prefer the **directory mount**
(`UPDATER_PROD_ENV_DIR`) so editing the env file never breaks the bind (the legacy
`UPDATER_PROD_ENV_FILE` single-file mount still works). See
**[docs/deployment/overview.md](docs/deployment/overview.md)**.

## Architecture

```
Browser ──WebSocket /ws/agent──▶ ws-server.mjs ──spawn per session──▶ ws-query-worker.mjs
   │                                  │                                    └─ Claude Agent SDK query()
   │                                  ├─ Better Auth (cookie)                 (sandbox, Skills, MCP)
   └─ TanStack Start (SSR + RPC)      ├─ session registry (concurrent sessions, per-user cap)
                                      └─ subscribe / fan-out by sessionId
```

- **Single agent runtime.** Kin uses the **Claude Agent SDK** over an **Anthropic-compatible
  gateway** (default ARK / Volcengine) — one runtime, not a second AI SDK. Each chat turn
  runs in its **own sandboxed child process**; the server multiplexes many concurrent
  sessions over one WebSocket and continues background runs after you navigate away.
- **Stateful streaming.** Real-time tool-call visualization, native session resume, and a
  server-authoritative running-state for the sidebar.
- **Worker pool & isolation.** A global worker semaphore plus a **per-user concurrency cap**
  bound resource use; idle reaping and WebSocket backpressure keep a single host healthy.
- **Sidecars.** A `parser` sidecar (PDF→Markdown for RAG) and an `updater` sidecar (online
  auto-update) keep the app image slim.

Single-entry chat lives at **`/agents/c`** (loose sessions) and **`/agents/projects/*`**
(project-scoped, with member sharing and branch-on-reply). Other surfaces: `documents` (knowledge base), `skills`, `mcp`, `ocr`, `capabilities`, `settings`.

## Tech stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js 22+ |
| **Agent** | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) over an Anthropic-compatible gateway (default **ARK / Volcengine**) |
| **Framework** | [TanStack Start](https://tanstack.com/start) — full-stack React (SSR + server functions) |
| **Realtime** | [`ws`](https://github.com/websockets/ws) WebSocket server + per-session worker processes |
| **UI** | [shadcn/ui](https://ui.shadcn.com/) + Tailwind CSS v4, dark mode, i18n (Intlayer) |
| **Data** | PostgreSQL + pgvector · [Drizzle ORM](https://orm.drizzle.team/) · Redis (BullMQ) · MinIO (S3) · Meilisearch |
| **Auth** | [Better Auth](https://better-auth.com/) (email/password, OAuth) |
| **Build / deploy** | Vite + Nitro · Docker Compose · GHCR multi-arch images · Traefik / Cloudflare Tunnel |

## Configuration

For production, prefer `scripts/install-vps.sh` or `scripts/install-tunnel.sh`; they generate
the datastore/auth secrets, `KIN_SECRET_KEY`, `UPDATER_TOKEN`, updater env mount, model seed,
and first-run email-verification setting. `.env.example` is a local-development/reference file,
not a production secrets file.

```bash
# Model gateway (ARK / Volcengine or any Anthropic-compatible endpoint)
# ⚠️ Use a Bearer token via ANTHROPIC_AUTH_TOKEN — do NOT also set ANTHROPIC_API_KEY.
ANTHROPIC_AUTH_TOKEN="<gateway-key>"
ANTHROPIC_BASE_URL="https://ark.cn-beijing.volces.com/api/coding"
ANTHROPIC_MODEL="<model-id>"

# Datastores (auto-generated by the installer)
POSTGRES_USER=... POSTGRES_PASSWORD=... POSTGRES_DB=...
MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... MINIO_BUCKET=...
MEILI_MASTER_KEY=...

# Auth
BETTER_AUTH_SECRET="<random>"
KIN_SECRET_KEY="<random>"      # enables admin-pasted model API keys
APP_HOSTNAME="kin.example.com"
ENABLE_EMAIL_VERIFICATION=false

# Online auto-update
UPDATER_TOKEN="<random>"
UPDATER_PROD_ENV_DIR="/abs/path/to/env-directory"
UPDATER_COMPOSE_ENV_FILE="/run/updater/envd/secrets.env"

# Model registry bootstrap (non-secret JSON; generated by the installers)
OXY_MODELS_SEED='{"default":"default/<model-id>", ...}'

# Optional features
RAG_ENABLED=true            # document knowledge base (needs the parser sidecar)
PER_USER_MAX_WORKERS=3      # concurrent running sessions per user
```

`VITE_WS_URL` is **not** baked into the image — the frontend computes
`wss://<current-host>/ws/agent` at runtime, so one image works for any domain. See
`.env.example` for the broader local-development reference. **Never commit `.env`.**

## Sizing & concurrency

Each chat turn runs in an isolated worker (**~0.5–0.6 GB while active**, measured; the Node
heap can grow toward its 1.5 GB cap for large generations). What consumes resources is the
number of **simultaneously executing** workers, not open sessions. Kin bounds this with a
**global worker semaphore** (default 8) and a **per-user cap** (`PER_USER_MAX_WORKERS`,
default 3); excess runs queue. A load test of **8 concurrent workers peaked at ~5 GB** and
returned to idle cleanly (no leak), so a **16 GB / 8-core** host comfortably serves a small
team with headroom. See **[docs/deployment/sizing.md](docs/deployment/sizing.md)**.

## Development

```bash
pnpm install
scripts/local-prod.sh --build   # build + serve (http://127.0.0.1:3100); deps run in Docker

# quality gates
pnpm typecheck
pnpm lint
pnpm validate-routes
pnpm test
```

> Note: `pnpm dev` (Vite HMR) is currently broken by a nitro-nightly bug — use
> `scripts/local-prod.sh` for local runs. See `CLAUDE.md`.

## Deployment docs

- **[Overview](docs/deployment/overview.md)** — paths, images, online auto-update
- **[VPS (public IP)](scripts/install-vps.sh)** — one-command installer
- **[Tunnel (Mac / NAT)](docs/deployment/tunnel.md)** — Cloudflare Tunnel
- **[Mac mini from scratch](docs/deployment/mac-mini.md)** — linear Path B guide for Apple Silicon
- **[Sizing](docs/deployment/sizing.md)** — host sizing & concurrency

## License

**[Apache License 2.0](LICENSE)** — free to use, modify, self-host, and build on, including
commercially (with an explicit patent grant). That covers everything in this repository.

Kin follows an **open-core** model: the core is, and stays, Apache-2.0. Bespoke **enterprise
plugin modules** are offered separately as optional paid add-ons (not part of this repo) —
you never need them to run Kin. See [LICENSING.md](LICENSING.md).

Kin is built on the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), subject to
[Anthropic's Commercial Terms](https://www.anthropic.com/legal/commercial-terms); see
[NOTICE](NOTICE) for full third-party attribution.

## Links

- **Repository**: https://github.com/deeptoai-com/kin
- **Container images**: https://github.com/deeptoai-com/kin/pkgs/container/kin%2Fapp
- **Contributing**: [CONTRIBUTING.md](.github/CONTRIBUTING.md) · **Security**: [SECURITY.md](.github/SECURITY.md)
