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

## Highlights

- 🧰 **Skills & MCP** — one-click enable/disable of curated skills and MCP servers; loaded
  into agent sessions live, no restart.
- 👥 **Projects & branch-on-reply** — share sessions with project members; non-owner replies
  fork the conversation so the original stays read-only and attributed.
- 🎨 **Artifacts + live preview sandbox** — generate web pages / docs / React / SVG, and run
  multi-file web apps in a per-session sandbox container on their own subdomain.
- 🐍 **Sandboxed code execution** — isolated per-session runtime for code, data analysis,
  automation.
- 📚 **Document knowledge base (RAG)** — upload PDFs/docs, parsed and embedded into a
  searchable knowledge base scoped per conversation; citations are clickable.
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

## Quick start

> Kin ships **prebuilt multi-arch images** to GHCR
> (`ghcr.io/deeptoai-com/kin/{app,parser,updater}`), so you don't build the heavy app
> locally — the installer just pulls them.

### Option A — One-command VPS install (public-IP host) ⭐

For a fresh Ubuntu/Debian VPS with a public IP and a domain on Cloudflare. Installs Docker
if missing, generates all datastore/auth secrets, prompts only for what can't be
auto-generated (model-gateway key, domain, Cloudflare DNS token), pulls the images, brings
up the stack behind Traefik + Let's Encrypt, and waits until it serves.

```bash
git clone https://github.com/deeptoai-com/kin.git
cd kin
sudo bash scripts/install-vps.sh            # interactive
# or, fully non-interactive:
#   sudo APP_HOSTNAME=kin.example.com ANTHROPIC_AUTH_TOKEN=... ANTHROPIC_BASE_URL=... \
#        ANTHROPIC_MODEL=... ACME_EMAIL=you@example.com CF_DNS_API_TOKEN=... \
#        bash scripts/install-vps.sh --yes
```

When it finishes, open `https://<your-domain>` and register the first account.

### Option B — Mac / workstation / behind NAT (OrbStack + Cloudflare Tunnel)

No public IP needed: a `cloudflared` container opens an outbound tunnel to Cloudflare, so
the same images run on your Mac (OrbStack/Docker Desktop) or home server and are reachable
on your domain. See **[docs/deployment/tunnel.md](docs/deployment/tunnel.md)**.

```bash
git clone https://github.com/deeptoai-com/kin.git && cd kin
cp .env.example .env                         # fill in secrets + APP_HOSTNAME + model gateway
# put your tunnel credentials in infra/tunnel/ (see docs/deployment/tunnel.md)
docker compose -f docker-compose.tunnel.yml -p kin up -d
```

> A dedicated `install-mac.sh` is on the roadmap; today the Mac path is the tunnel compose
> above.

### Option C — Local development

Runs the dependency services (Postgres, Redis, MinIO, Meilisearch) in Docker and the app as
a local Node process. See **[Development](#development)** and `CLAUDE.md`.

```bash
git clone https://github.com/deeptoai-com/kin.git && cd kin
pnpm install
scripts/local-prod.sh --build                # builds + serves on http://127.0.0.1:3100
```

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

Copy `.env.example` to `.env` and set the essentials. Datastore/auth secrets are
auto-generated by `install-vps.sh`; for manual setups set them yourself.

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
APP_HOSTNAME="kin.example.com"

# Optional features
RAG_ENABLED=true            # document knowledge base (needs the parser sidecar)
PER_USER_MAX_WORKERS=3      # concurrent running sessions per user
```

`VITE_WS_URL` is **not** baked into the image — the frontend computes
`wss://<current-host>/ws/agent` at runtime, so one image works for any domain. See
`.env.example` for the full list. **Never commit `.env`.**

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
