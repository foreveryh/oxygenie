# Kin — Roadmap

Phased plan from foundation to surpassing Deep Agents. Each phase lists its goal
and **exit criteria**. Track live progress in [`STATUS.md`](./STATUS.md).

> Sequencing principle: *foundation (safe parallel work) → decide the execution
> runtime/scale model → close security gaps → make capabilities measurable → catch
> up to Deep Agents.* Don't build features on an unsafe / untestable / un-scalable base.

---

## 🧭 Current focus — Now / Next / Later (set 2026-06-30)

The phase plan below (0 → 4 + Skills) is largely delivered. **MVP multi-model selection is now Done.**
Owner-set: **Now = Polish + CI health + documentation maintenance.**

### 🟢 NOW — Polish, CI health, and documentation cleanup
**Goal:** close the remaining loose ends after the major feature waves (Phase C, multi-model, Workbench, OCR) so the project is consistent and maintainable.
- [~] **Re-enable free CI build** — **build OOM is FIXED**: `build.yml` (7 GB runner) now builds the
      slim image to completion (verified on the #110 main run — no OOM). It currently fails only at the
      GHCR **push** (`denied: write_package`) because the `oxygenie/app` package was created manually
      and has **no linked repo**. One-time fix: package → *Manage Actions access* → add `foreveryh/oxygenie`
      (Write), then re-run build.yml. After that, push-main auto-publish is green.
- [~] **TS-ify the agent runtime** — `ws-server.mjs` / `ws-query-worker.mjs` remain plain `.mjs`;
      typed WebSocket protocol is still deferred. This is a prerequisite for safely adding more harness features.
- [ ] **Fix remaining TypeScript errors** → re-enable `typecheck` as a hard gate.
- [ ] **Make tests CI-runnable** (split unit vs e2e; provision Postgres/services) → re-enable `test` as a hard gate.
- [ ] **Migrate 15 REST routes → Server Functions** → re-enable `validate-routes` as a hard gate.
- [ ] **Blog/lessons maintenance** — rewrite the `docs/blog/zh/` series as self-contained lessons,
      remove internal cross-references and "next/prev" links, and update stale status descriptions
      (especially Workbench, preview, multi-model, and RAG).

**Exit:** CI gates are green and meaningful; docs reflect the current state of the code.

### 🔵 NEXT — Capabilities and scale maturity
- [x] **🎯 Multi-model selection (MVP) — DONE (2026-06-07)** — users pick the model per conversation,
      across connections/accounts (any Anthropic-protocol gateway), only among currently-healthy ones.
      Shipped: DB registry (`model_connection`/`model_definition`/`model_health`) seeded from
      `OXY_MODELS_SEED` (+ legacy `ANTHROPIC_*` fallback); **6h health probe** (BullMQ, + probe-on-boot)
      → menu gating; typed `/api/models/resolve` endpoint + **per-request worker-env routing**
      (baseURL/auth/model/aliases, reject-on-unhealthy); composer **picker**; **`/admin/models`** board
      **+ CRUD**; per-conversation memory (localStorage). Secrets stay in env (tokenEnv name only).
      Verified: ARK serves GLM-5.1 / Doubao-Seed-2.0-Code/-Pro / MiniMax behind one endpoint (all 200).
      *(PRs #126/#127/#129/#130/#131/#132/#133/#134/#136/#137)* Spec: `prd/2026-06-multi-model-switching-prd.md`.
      **Remaining (Phase 4 stretch):** cross-provider routing/failover, capability-gating, cross-device (DB) model persistence.
- [x] **Agent code sandbox** — fixed the registration sequencing bug (eager `ensureSandbox()`
      before the check; `state=null` → bash never registered). Verified live (srt active). *(PR #112)*
- [x] **Path A completeness** — **`docker-compose.prod.yml`**: bundled Traefik + websecure/TLS + the
      `preview-auth` router (v3 `HostRegexp`) + the preview wildcard cert, plus the **`dockerproxy`
      API-version shim** (Docker 28/29 raised the daemon min API to 1.40; Traefik v3.5's pinned client
      v1.24 is rejected on a direct socket — the nginx shim rewrites `/vX.Y/`→`/v1.44/`). **Two TLS
      options**: Let's Encrypt DNS-01 (default) + Cloudflare Origin CA (`infra/prod/dynamic/`).
      **Verified on a real Linux VM** (Ubuntu 22.04 / Docker 29 via Multipass): migrate exit 0,
      /health 200, /ws/agent 426, http→https 301, preview ensure→install→start + subdomain
      forward-auth, userns/bwrap OK — this VM run is what caught the shim bug. *(PR #113/#114)*
      **Residual**: LE DNS-01 wildcard issuance not yet exercised against real public DNS (the VM used
      a local-only domain; config is shared with the proven CF/Origin-CA stacks). Guide: `docs/deployment/docker-compose.md`.
- [x] **OCR module** — end-to-end scanned-document OCR: lazy thumbnail navigation, page state badges,
      parse/render timeouts for large PDFs (2.4 MB annual reports), reopen restoring original files and full page set,
      explicit error backflow. Shipped to `/agents/ocr`. *(PRs #158–#163)*
- [x] **Workbench hardening** — Files panel reads real workspace FS, `info` → Context integration,
      Progress/Sub-agents auto-populate the correct tabs, collapsible side rails (session history + workbench),
      unified session-file button controlling the right panel. *(PRs #153/#154/#155/#156/#157)*
- [x] **Permission visualization + Bash capability convergence** — `/admin/permissions` board,
      runtime capability config stored and wired, `allowBash` decoupled from `permissionMode`, native `Bash`
      permanently disallowed, controlled `mcp__bash__run` closed-loop. *(PRs #148/#149/#150/#151)*
- [x] **Upload pipeline + chat switch fixes** — attachment delivery via stable side-channel, upload format
      allowlist, pause/resume, white-screen fix when switching conversations. *(PRs #138/#139/#144/#145)*
- **Skills / MCP curation ("lists")** — content refresh (skills-api `scrapedAt`/ETag), admin
  curation UI for the official catalog, an **MCP catalog/picker**, and fix any stale "coming soon" copy.

### 🟣 LATER — Gates, accounting, and architectural debt
- **Multi-model Phase 4** — cross-provider routing/**failover** + per-capability key split + capability gating (e.g. vision-only models) + cross-device model persistence.
- **Accounting (Phase 2 wiring)** — call `spendOneCredit`, persist per-run cost/tokens, enable the
  audit log, stop logging raw message content (PII).
- **Workspace as a first-class concept** — decouple Workspace from Conversation; stable absolute paths.
- **Conversation history in our own DB** — make Postgres the source of truth for messages; SDK transcript becomes resume input.
- **Context management / memory layer** — summarization, compaction, and long-term memory (design docs D2/D3).
- **Unify per-message worker and per-session preview runtime** — shared lifecycle and warm workspace pool.
- **Revisit `ENABLE_STRUCTURED_OUTPUTS`** now that Phase C is done; resolve the StructuredOutput-leak root cause instead of keeping the flag forced-off.
- **Misc** — email-verify self-host UX; P16 artifact version recording (paused); deprecated-fn cleanup (`syncOldUserSkills`, `getSkillStatus`).

---

## Phase C — Real preview engine + deployment — ✅ DONE (2026-06-06)

**Goal:** users see agent-generated multi-file apps actually run, and the whole product is
deployable by a team. **Shipped + verified live on `oxygenie.cc`.**

- [x] **Real-preview v1 backend** — `PreviewRuntime` + `preview-controller` sidecar (sole
      docker-socket holder) creating per-preview sandbox containers + Traefik labels; one-time
      token → cookie forward-auth; `.oxygenie/app.json` manifest. *(PR #107)*
- [x] **Front-end seam** — `previewState` in the store + ws-adapter + `useSessionPreview`;
      「运行预览」CTA on the index.html artifact → live iframe.
- [x] **End-to-end fixes** (from a real-world test): Traefik **v3 `HostRegexp`** (the preview 404
      — was misattributed to Dokploy/Swarm), artifact-card **retarget to the most-previewable file**
      (CTA now appears), agent **no longer self-installs** (prompt: preview engine does install/build/serve).
- [x] **Shared preview dependency cache** — `/pm-cache` volume across previews + `warm-cache.sh`
      (cold ≈15 s → warm ≈4 s installs).
- [x] **All three deploy paths** — A/Compose-VPS (`docker-compose.prod.yml`, **VM-verified** on
      Ubuntu 22.04/Docker 29; LE DNS-01 + CF Origin CA; `dockerproxy` shim), B/Dokploy (live),
      C/Cloudflare-Tunnel (Mac, live + verified), with authoritative guides
      (`docs/deployment/{overview,docker-compose,dokploy,tunnel,mac-mini}.md`).
- [x] **Preview UX + sharing** — deliverable card gated to **end-of-turn** so 「打开成果物/运行预览」
      only shows once the whole turn finishes (#115); **share = public-link toggle** (#116:
      `/__oxy/preview/authorize` bypass for public hosts + pinned-alive while shared → token-free
      `<id>.<domain>/` link anyone can open); preview lifecycle + sharing documented in README(_CN) +
      the v1 plan §8 (#117). Mac local browser test via mkcert + dnsmasq (trusted wildcard cert).

**Exit criteria:** met — full preview + sandbox verified end-to-end over the public path; **all three
deploy paths shipped** (Path A VM-verified on Linux/Docker 29); preview sharing + lifecycle done & documented.

---

## Phase 0 — Foundation (enable safe, parallel contribution)

**Goal:** anyone of any skill level can contribute safely, in parallel, with
guardrails.

- [x] Split product into its own repo (`oxygenie`), history + tags preserved.
- [x] Hygiene: untrack `.env.docker` (+ template), ignore runtime data dirs.
- [x] Secret-leak audit of full history (clean).
- [x] CI gates on `main`: build check + **gitleaks** secret scan + PR template + CODEOWNERS.
- [x] Branch protection on `main` (required checks + CODEOWNER review, no direct push).
- [ ] **Isolated, reproducible dev environment** (devcontainer / compose dev
      profile; secrets separated; one-command boot of web + ws-server + services).
- [ ] **TS-ify the agent runtime** (`ws-server.mjs`/`ws-query-worker.mjs`) with a
      typed WebSocket message protocol — prerequisite for safely adding harness features.
- [ ] Make the test suite CI-runnable (split unit vs e2e; provision Postgres/services)
      → re-enable `test` as a hard gate.
- [ ] Fix TS errors → re-enable `typecheck` as a hard gate.
- [ ] Migrate 15 REST routes → Server Functions → re-enable `validate-routes` as a hard gate.

**Exit criteria:** green, meaningful CI as a hard gate; a contributor can boot the
full stack locally in one command without touching real secrets.

---

## Phase 0.5 — Execution-runtime architecture & sandbox (decision + re-platform)

**Goal:** stand up a safe, *bounded* execution model so the product runs reliably on a
single modest VPS — explicitly targeting **one 16GB / 8-core host, ~50 concurrent
sessions** — before any multi-machine work. Grounded by
[`research/2026-05-scalability-and-runtime.md`](./research/2026-05-scalability-and-runtime.md)
and [`research/2026-05-single-host-50-concurrency.md`](./research/2026-05-single-host-50-concurrency.md).

Why now: the current model spawns a Node child **per message with no concurrency cap**,
so a burst of concurrent users can OOM the box. The sandbox primitive (srt) and the
pluggable `ExecutionRuntime` are done; what remains for the single-host target is
concurrency governance (cap + queue + resource limits), not multi-machine distribution.

- [x] **Adopt `@anthropic-ai/sandbox-runtime` (srt)** (TS, Apache-2.0) as the exec
      sandbox primitive — deny-network + workspace-fenced FS per tool-call. This *is*
      the Risk #1 fix; it uses bubblewrap (already installed) under the hood on Linux. *(PR #3/#29)*
- [x] **Define an `ExecutionRuntime` interface** (exec / stop / sandboxStatus; start/stream/
      abort/snapshot reserved) — pattern from hermes-agent `BaseEnvironment` + deer-flow
      `SandboxProvider`. First backend `LocalProcessBackend` (local-process + srt), behind
      `getExecutionRuntime()` (EXEC_RUNTIME selector). Behavior-identical refactor. *(PR #39, PR-1)*
- [x] **Second backend `DockerBackend`** — per-exec locked-down container (network none,
      non-root, read-only rootfs + workspace mount, cpu/mem/pids caps, host env not
      inherited). Container-grade isolation on any host incl. macOS. `EXEC_RUNTIME=docker`. *(PR #41, PR-2)*
**Single-host target work (S1–S5) — directly hits "50 on one 16G/8-core box":**
- [x] **S1 — Bounded worker concurrency + queue** (`MAX_CONCURRENT_WORKERS`, default 8):
      FIFO Semaphore caps simultaneously-active workers, queues the rest, sends a `queued` frame.
      Direct OOM fix (≤8 parallel × ~250MB ≈ 2GB vs 50 × 250MB ≈ 12.5GB). Verified: boots clean,
      env override honored, semaphore unit tests + `test:unit` 20/20. *(PR #48)*
- [x] **S2 — Per-worker resource caps**: `WORKER_MAX_OLD_SPACE_MB` → node `--max-old-space-size`;
      Docker backend reuses `EXEC_DOCKER_MEMORY`. *(PR #51)*
- [x] **S3 — Idle WS connection reaper**: `WS_IDLE_TIMEOUT_MS` + `shouldReapIdle()` (skips active
      workers; pong ≠ activity). *(PR #52)*
- [x] **S5 — Capacity load-test harness** (`scripts/loadtest/`, Phase A local). Calibrate defaults
      on a real 16G/8-core box + write results to README. *(PR #53)*

**Deferred to a future multi-machine goal (design stored, not executed for single-host 50):**
- [~] **Move execution off per-message spawn** → per-session warm pool. Not needed for single-host 50.
- [~] **Decouple tiers**: stateless gateway · shared state (Postgres/Redis) · object-store
      workspaces · queue-driven worker pool. Design in `research/2026-05-tier-decoupling-design.md`.
- [~] **Pick the scale backend** (Modal/Daytona/E2B vs self-managed pool) — multi-machine only.
- [~] **Concurrency spike 100 → 1000** — future multi-machine target.
- [x] **(folded from Phase 1) Unify path guards**: the 5 routes' duplicated
      `validateFilePath` → one shared `validateRelativePath` module (+ hardening, unit tests). (B3) *(PR #42)*
- [x] **(folded from Phase 1) Backpressure**: worker awaits stdout `drain`; ws-server pauses
      `worker.stdout` on high `ws.bufferedAmount` — a fast stream + slow client can't OOM. (C4) *(PR #43)*

**Exit criteria (revised):** `ExecutionRuntime` + srt sandbox live (✅); **bounded worker
concurrency + queue + per-worker resource caps**, with a capacity bench showing a single
16GB/8-core host sustains ~50 concurrent sessions without OOM. (Multi-machine tier
decoupling + the 1000-session benchmark are a *separate future goal*, design stored in
`research/2026-05-tier-decoupling-design.md`.)

---

## Phase 1 — Security hardening (gate before real/multi-tenant use) — ✅ CORE DONE

**Goal:** close the high-severity risks from the architecture review so the
product is safe to run with real data / real tenants.
**Status (2026-05-30):** core risks fixed + merged; app browser-verified end-to-end.
Remaining hardening items (B3 path-guard unify, C4 backpressure) are folded into
Phase 0.5 because the execution-runtime rewrite touches the same code.

- [x] **Sandbox the exec tools** (Python/Bash) — `srt` (deny-net, workspace-fenced FS)
      + secret env-strip; Linux-only OS sandbox, env-strip always on (PR #3, #29). *(Risk #1)*
- [x] Keep `canUseTool` active even in `bypassPermissions` mode (PR #15). *(Risk #2)*
- [x] Owner predicates fix **cross-tenant file/attachment access** (PR #4, 8 handlers). *(Risks #3,#4)*
- [x] `maxTurns` + wall-clock watchdog (PR #5). *(Risk #5; `maxBudgetUsd` deferred to Phase 2 cost work)*
- [x] Worker-crash terminal frame + removed dead `ws.abortController` (PR #22/#23/#24). *(Risk #10 / C2-C3)*
- [x] Unit test + CI hard-gate for the path-security guard (PR #26/#27).
- [ ] Fix deploy so the WS server actually boots; reconcile ports. *(Risk #8 — needs deploy access; HUMAN-REVIEW)*
- [ ] Multi-user cross-tenant **integration** test (needs DB+auth harness). *(folded into test work)*
- [→] B3 unify the two path-traversal guards · C4 backpressure → **moved to Phase 0.5** (same code).

**Exit criteria:** every "high"/"critical" review risk has a fix + a regression test.
**Met for Risks #1/#2/#3/#4/#5/#10** (code + unit/smoke + browser e2e). #8 and full
multi-user integration tests remain (tracked above / HUMAN-REVIEW).

---

## Phase 2 — Observability & accounting (make "production" measurable)

**Goal:** you can tell whether the system is healthy and what it costs.

- [ ] Actually meter usage (`spendOneCredit` is currently never called).
- [ ] Persist token/cost/turns per run server-side (from the SDK `result` event).
- [ ] Audit log table for security-relevant actions.
- [ ] Stop logging raw message content unconditionally (PII).

**Exit criteria:** per-run cost + usage visible and billable; an audit trail exists.

---

## Phase 3 — Catch up to (and pass) Deep Agents (capabilities)

**Goal:** match Deep Agents' harness strengths, on top of our platform advantages.

- [x] **Todo / plan panel** (surface `TodoWrite` as structured UI). *(Wave 1, #60)*
- [~] **First-class sub-agent panel** — flat Task list done (Wave 1); **nested tree** still pending
      (needs `parent_tool_use_id` on tool-call parts).
- [x] **Human-in-the-loop tool approval** (Ask/Act + approve/reject round-trip). *(Wave 2, `feat/ask-act-hitl`, owner-tested 2026-06-04)*
- [ ] **Checkpointing / durable run resume** (resume an interrupted run, not just reload history).
- [ ] **Context management** (summarization / compaction; memory layer).
- [ ] Unify shared logic so the two runtimes can't fork (skill-sync, path guards).

**Exit criteria:** parity-or-better with `deep-agents-ui` on todo/sub-agent/HITL,
plus durable resume — while keeping our isolation + multi-tenant + web edge.

---

## Skills integration (capabilities workstream) — ✅ S1–S4 DONE (2026-06-04)

**Goal:** a curated, team-private Skills library (no public market) on a **DB-catalog** model
(DB = truth, `~/.claude/skills/` = runtime projection), with upstream discovery + governance.
Full design + decisions: [`prd/2026-06-skills-integration-prd.md`](./prd/2026-06-skills-integration-prd.md).
Owner-tested 2026-06-04.

- [x] **S1 — Catalog + display**: `skill_catalog` (+ `skill_content_cache`, `skill_schema_cache`,
      `skill_enablement`), curated-100 seed wired into `migrate`, browse/search/category + SKILL.md
      detail from skills-api (cached). *(#90/#91/#92, migration 0020)*
- [x] **S2 — Execution layer**: install→My-Skills materializes to `~/.claude/skills/<slug>/`
      (effective **next conversation** — SDK can't hot-reload a live session); default-2
      (`find-skills`+`skill-creator`) auto-installed & locked (D6); fillable-variable schema
      generated locally into the DB, cache-first by content-hash (D5). *(#93/#95)*
- [x] **D9 — retire legacy FS store**: deleted the 8 `baoyu` local assets (curated-100 already
      references baoyu upstream → no capability lost). *(#94)*
- [x] **S3 — upstream discovery**: search skills-api → add as user-scoped catalog entry; admin
      governance page `/admin/skills` (see + remove all users' added skills, D10). *(#96)*
- [x] **S4 — composer rework + cleanup**: composer reads DB schema; worker injects a lean
      skill hint (not the full SKILL.md) to save tokens; user-upload migrated into the catalog
      (`source='upload'`, multi-file materialize); legacy `SkillsPageComponent` removed. *(#97/#98/#99, migration 0021)*

**Remaining (maintenance only — none blocking):**
- [ ] **Content refresh** — re-fetch on upstream change via skills-api `scrapedAt`/ETag → recompute
      content-hash → mark schema `stale` → regenerate.
- [ ] **Schema background prewarm** — move generation into the BullMQ worker (prewarm curated set,
      regenerate on `stale`) instead of the on-demand button.
- [ ] **Admin curation** — UI to add/edit/remove **official** catalog entries (today seed-only).
- [ ] **Team/org-level sharing** — promote user-added/uploaded skills to org-shared (today
      per-owner + admin governance).
- [ ] **(optional) composer "browse all installed" picker** with inline variable form.

**Exit criteria:** met for S1–S4 (catalog browse/install/run/detail/schema/upstream-add/upload +
admin governance, build+lint green, owner-tested). Maintenance items above are tracked in STATUS Backlog.

**Config:** `SKILLS_API_URL` (default `https://skills-api.deeptoai.com`), optional `SKILLS_API_KEY`.

---

## Phase 4 — Multi-model MVP ✅ + scale maturity (stretch)

**Goal:** real provider abstraction and horizontal scale.

- [x] **MVP multi-model selection** — per-conversation model picker, health probes, DB registry,
      `/admin/models` CRUD, per-request worker-env routing. *(Done 2026-06-07, PRs #126–#137)*.
- [ ] **Cross-provider failover and capability gating** — route/failover across multiple Anthropic-compatible gateways;
      split shared credentials per capability; gate models by capability (vision, long-context, etc.).
- [ ] **Concurrency caps / backpressure / horizontal scale story for ws-server** — beyond single-host 50 sessions.

**Exit criteria:** swap/route models without code changes; bounded resource use under load.
