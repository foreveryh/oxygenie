# Kin — Status (Living Memory)

> **This is the living memory of the project. Update it whenever state changes.**
> Last updated: **2026-06-30**

## Current position (one-paragraph snapshot)

**2026-06-30 — Major feature waves are closed; focus is on consistency, CI health, and documentation maintenance.**
Since the last snapshot (2026-06-07), the project has shipped OCR, Workbench hardening, permission visualization,
controlled Bash, upload pipeline fixes, and brand alignment. The `docs/blog/zh/` series is now out of date and is being
rewritten as self-contained lessons. The remaining active work is: fix the last CI red flags (GHCR push link, TS errors,
test/validate-routes gates), and keep ROADMAP/STATUS/blog aligned with `main`.

Notable closed items:
- **OCR module** (`/agents/ocr`) shipped with lazy thumbnail navigation, large-PDF timeout handling, and explicit error backflow.
- **Workbench** now reads real workspace FS, auto-opens the right tab, and has collapsible rails.
- **Permissions + Bash capability** converged: native `Bash` is permanently disallowed; shell work goes through `mcp__bash__run` gated by `allowBash`.
- **Upload pipeline** moved attachment delivery to a stable side-channel and fixed the conversation-switch white-screen.
- **Brand alignment** to **Kin** completed in `CLAUDE.md` and `package.json` metadata.
- **Projects P1 + branch-on-reply** shipped: `project` / `project_member` / `projectId` on sessions + documents + KBs, single access resolver (`src/server/projects/access.ts`), owner email-invite sharing, and non-owner reply → `forkSession` branch (`branchedFromSessionId`).

Still open from earlier phases:
- Phase 2 accounting: `spendOneCredit` is still not wired into production flow; audit log is written but not enabled as a gate.
- Phase 3 durable run resume and nested sub-agent tree are still pending.
- Phase 4 multi-model MVP is done; cross-provider failover and capability gating remain.
- Phase 0 CI hard gates (`typecheck`, `test`, `validate-routes`) are still non-blocking.
- Projects: project-level instructions are stored but not yet auto-injected into session system prompts. Branch-on-reply source deletion after fork is a known boundary case.

## Phase tracker

| Phase | State |
|---|---|
| Research (architecture review, Deep Agents comparison, scalability/runtime) | ✅ Done |
| **Phase 0 — Foundation** | ✅ Largely done (repo/CI/dev-stack/live-model) |
| **Phase 1 — Security hardening** | ✅ Core done (Risks #1/#2/#3/#4/#5/#10) |
| **Phase 0.5 — Execution-runtime + single-host concurrency** | ✅ Done (ExecutionRuntime #39, DockerBackend #41, B3 #42, C4 #43/#45, S1 #48, S2 #51, S3 #52, S5 #53) — single 16G/8-core ~50 concurrent target |
| **Phase 2 — Observability & accounting** | ✅ Mechanisms done (usage_record #55, audit_log #56, metering+quota OFF-by-default #57); **spendOneCredit still not called in production** |
| **Phase 3 — Catch up to Deep Agents (capabilities + UI/UX)** | ✅ Core done (Todo panel, flat Task list, Ask/Act HITL); **nested sub-agent tree + durable run resume still pending** |
| **Phase C — Real preview engine + deployment** | ✅ Done (PR #107 + E2E fixes + dep cache + all 3 deploy paths; end-of-turn deliverable card #115; preview sharing #116; lifecycle docs #117) |
| **Slimming (NOW)** — remove Mastra + playwright + libreoffice → free CI build | ✅ Done; only GHCR package→repo link remains to turn push-main auto-publish green |
| **MVP Multi-model selection** | ✅ Done (2026-06-07, PRs #126–#137) |
| **Phase 4 — Multi-model scale + cross-provider failover** | ⬜ Not started (stretch) |

## Done (most recent first)

- ✅ **Brand alignment to Kin** — `CLAUDE.md` and `package.json` metadata updated to reflect the Kin identity; stale `oxygenie` / `OxyGenie` references removed from user-facing docs. *(PR #187, 2026-06-30)*
- ✅ **CI/build red-line cleanup** — `gitleaks` config updated, `DATABASE_URL` compose collision fixed, and build OOM remains fixed. *(PR #188, 2026-06-30)*
- ✅ **Removed legacy ex0 Ansible/Caddy deployment subsystem** — dead paths and templates deleted. *(2026-06-30)*
- ✅ **Dokploy compose cleanup** — debug artifacts removed, env landmines fixed. *(2026-06-30)*
- ✅ **OCR module shipped** — lazy thumbnail navigation, page state badges, parse/render timeouts for 2.4 MB PDFs, reopen restores original files and full page set, explicit error backflow. *(PRs #158–#163, 2026-06-30)*
- ✅ **Workbench hardening** — Files panel reads real workspace FS, `info` → Context integration, Progress/Sub-agents auto-populate correct tabs, collapsible side rails, unified session-file button. *(PRs #153–#157, 2026-06-30)*
- ✅ **Permission visualization + Bash capability convergence** — `/admin/permissions` board, runtime capability config stored and wired, `allowBash` decoupled from `permissionMode`, native `Bash` permanently disallowed, controlled `mcp__bash__run` closed-loop. *(PRs #148–#151, 2026-06-30)*
- ✅ **Upload pipeline + chat switch fixes** — attachment delivery via stable side-channel, upload format allowlist, pause/resume, white-screen fix when switching conversations. *(PRs #138/#139/#144/#145, 2026-06-30)*
- ✅ **Preview no-build static serve** — pure front-end artifacts are served without a build step, closing a real-preview hard-acceptance gap; multi-file React apps route to the real preview engine instead of Sandpack. *(PRs #152/#153, 2026-06-30)*
- ✅ **Slimming: Mastra + playwright + libreoffice removed → CI build OOM fixed** (PRs #109/#110, 2026-06-06). #109 removed Mastra entirely; #110 removed playwright + libreoffice so the lean image is the only image. **Result: `build.yml` on the 7G GitHub runner builds the slim image to completion (no OOM).** Only the GHCR push needs a one-time package→repo link.
- ✅ **Phase C real-preview deployed + verified live** (merge `78f46af`, 2026-06-06): real-preview v1 + front-end seam, then Traefik v3 `HostRegexp` fix, artifact-card retarget to most-previewable file, agent no-self-install, shared preview dep cache (`/pm-cache` + `warm-cache.sh`). Verified end-to-end over the public path.
- ✅ **Deployment: 3 paths + guides** (2026-06-06): C/Cloudflare-Tunnel live + full-feature; B/Dokploy live; A/Compose bundled + VM-verified on Linux/Docker 29 (#113/#114). Authoritative guides `docs/deployment/{overview,dokploy,tunnel,mac-mini}.md`.
- ✅ **MVP Multi-model selection** (2026-06-07, PRs #126–#137): per-conversation model picker, health probes, DB registry (`model_connection`/`model_definition`/`model_health`), `/admin/models` CRUD, per-request worker-env routing. Verified ARK serves GLM-5.1 / Doubao-Seed-2.0-Code/-Pro / MiniMax behind one endpoint.
- ✅ **Projects P1 + branch-on-reply** (PRs around #120–#140, 2026-06): `project` + `project_member` tables, `projectId` on `agent_session`/`documents`/`knowledge_bases`, single access resolver (`src/server/projects/access.ts`), owner email-invite sharing, non-owner reply triggers SDK `forkSession()` into a new `branchedFromSessionId` session in the same project. Unit-tested access logic; live branch-on-reply integration verified per `docs/project/research/2026-06-10-codebase-audit-truth-vs-docs.md`.
- ✅ **Skills integration S1–S4** (PRs #90–#99, 2026-06-04): DB catalog replaces FS skills-store. S1 catalog + browse/detail; S2 install→My-Skills + fillable schema; S3 upstream search/add + admin governance; S4 composer→catalog + upload migration. Migrations 0020 + 0021.
- ✅ **Phase 3 Wave 2: Ask/Act + HITL** (2026-06-04): two modes (Ask pauses on action tools for approval; Act autonomous), stdin line protocol for HITL, UI approval prompt. R4 (#69) resolved by removing the read-only `explore` tier.
- ✅ **Phase 0.5 PR-4 — WebSocket backpressure (C4)** (PR #43): worker `send()` awaits stdout `drain`; ws-server pauses `worker.stdout` above 8MB `ws.bufferedAmount`.
- ✅ **Phase 0.5 PR-3 — unify route path guard (B3)** (PR #42): duplicated `validateFilePath` → shared `src/server/security/validate-relative-path.ts`.
- ✅ **Phase 0.5 PR-2 — `DockerBackend`** (PR #41): per-exec locked-down container.
- ✅ **Phase 0.5 PR-1 — `ExecutionRuntime` interface + `LocalProcessBackend`** (PR #39): pluggable execution backend.
- ✅ **Risk #5 — agent run bounds** (PR #5): `AGENT_MAX_TURNS`, `AGENT_WALLCLOCK_TIMEOUT_MS`.
- ✅ **Risks #3/#4 — cross-tenant access** (PR #4): owner predicates on 8 handlers.
- ✅ **Risk #1 — exec sandbox** (PR #3): srt wraps Python + secret env-strip.
- ✅ **main branch protection** on `oxygenie` (required checks: Quality Checks + gitleaks; 1 review + CODEOWNER).
- ✅ **CI gates merged to main** (PR #1): `pnpm build`, gitleaks, PR template, CODEOWNERS.
- ✅ **Secret-leak audit** of full git history: clean.
- ✅ **Repo split**: product extracted to `github.com/foreveryh/oxygenie` with full history; made public.

## In progress

- 🔵 **Documentation maintenance** — rewrite `docs/blog/zh/` as self-contained lessons and update `reading-map.md`.
- 🔵 **CI hard gates** — fix TS errors, make tests CI-runnable, migrate 15 REST routes → Server Functions.

## Next up (roughly ordered)

1. ⬜ **Fix remaining TypeScript errors** → re-enable `typecheck` as a hard gate.
2. ⬜ **Make tests CI-runnable** (unit/e2e split + service containers) → re-enable `test` gate.
3. ⬜ **Migrate 15 REST routes → Server Functions** → re-enable `validate-routes` gate.
4. ⬜ **Wire accounting** — call `spendOneCredit`, enable quota gate, stop logging raw message content (PII).
5. ⬜ **Conversation history in our own DB** — make Postgres the source of truth for messages; SDK transcript becomes resume input.
6. ⬜ **Workspace as a first-class concept** — decouple Workspace from Conversation; stable absolute paths.
7. ⬜ **Nested sub-agent tree** — add `parent_tool_use_id` to tool-call parts for hierarchical display.
8. ⬜ **Durable run resume** — checkpointing / resume an interrupted run, not just reload history.
9. ⬜ **Context management / memory layer** — summarization, compaction, long-term memory.
10. ⬜ **Cross-provider model failover and capability gating** — Phase 4 stretch.

## Backlog (with difficulty tags)

| Item | Difficulty | Notes |
|---|---|---|
| Migrate 15 REST routes → Server Functions | M | Overlaps cross-tenant security fixes (Risks #3/#4) |
| Make tests CI-runnable (unit/e2e split + services) | M | Then make `test` a hard gate |
| Fix TS errors | S–M | Then make `typecheck` a hard gate |
| Wire accounting (`spendOneCredit`) | M | `spendOneCredit` never called; persist per-run cost/tokens; enable audit log gate; stop logging raw message content (PII) |
| **Workspace as a first-class concept** | L | Decouple Workspace from Conversation; stable absolute paths; conversation belongs to a workspace |
| **Conversation history in our own DB** | M–L | Postgres source of truth for messages; SDK transcript becomes resume input |
| **Skills: content refresh (scrapedAt/ETag)** | M | Detect upstream changes via skills-api and regenerate stale schemas |
| **Skills: schema background prewarm (worker)** | M | Move fillable-schema generation into BullMQ worker |
| **Skills: admin curation of the catalog** | M | Admin UI to add/edit/remove official catalog entries |
| **Skills: team/org-level sharing** | L | Promote user-added skills to org-shared |
| **Skills: composer "browse all installed" picker** | S–M | Convenience picker listing all installed skills with inline form |
| **MCP catalog/picker + fix stale "coming soon" copy** | M | Curated MCP selection UI; verify any stale copy |
| **Context management / memory layer** | L | Summarization, compaction, long-term memory (design docs D2/D3) |
| **Unify per-message worker and per-session preview runtime** | L | Shared lifecycle and warm workspace pool |
| **Revisit `ENABLE_STRUCTURED_OUTPUTS`** | M | Resolve StructuredOutput leak root cause instead of keeping the flag forced-off |
| **Email-verify self-host UX** | S | Reduce friction on self-hosted email verification |
| **P16 artifact version recording** | S | Currently paused (`ENABLE_VERSION_RECORDING=false`) |
| **Deprecated-function cleanup** | S | `syncOldUserSkills`, `getSkillStatus` |
| **Archive old public repo `constructa-starter`** | S | Avoid two-public-repo confusion |
| **Bump gitleaks/checkout actions off Node 20** | S | Deprecation forced ~2026-06-16 |

## Known weakened gates (intentionally non-blocking until backlog done)

- `typecheck` — non-blocking (pre-existing TS errors).
- `validate-routes` — non-blocking (pre-existing REST-route violations).
- `test` — non-blocking (suite is e2e/integration; needs DB + live server in CI).

## Decision log (selected)

- **2026-06-30** — **OCR + Workbench + permissions + upload + brand alignment all merged.** The project is now in a documentation-maintenance phase. `docs/blog/zh/` is being rewritten as self-contained lessons.
- **2026-06-07** — **MVP multi-model selection completed.** Per-conversation model picker, DB registry, health probes, `/admin/models` CRUD, per-request worker-env routing. Phase 4 stretch remains cross-provider failover and capability gating.
- **2026-06-06** — **Phase C real-preview done and deployed live; roadmap reset.** Three deploy paths shipped. Slimming done except for GHCR push link.
- **2026-06-04** — **Ask/Act + HITL merged.** Removed read-only `explore` tier; Ask pauses for approval, Act autonomous. R4 resolved by redesign.
- **2026-06-02** — **Product positioning settled:** self-hosted private deployment for SMB teams, NOT public multi-tenant SaaS. Threat model = semi-trusted colleagues.
- **2026-05-29** — **Strategy:** harden + borrow from Deep Agents; do not migrate/integrate. Repo made public for free branch protection.

## How to use this file

- Update the **snapshot**, **Done/In progress/Next**, and **Decision log** as part of finishing any meaningful task.
- When a phase's exit criteria are met, flip its row in the Phase tracker and in `ROADMAP.md`.
- Keep difficulty tags on backlog items so work can be parcelled out by skill level.
