---
title: "Skills System — copy-on-enable, schema generation, and the disabled veto"
slug: 08-skills-system
date: 2026-06-07
keywords: [Skills, SKILL.md, copy-on-enable, schema generator, disabled veto]
---

# Skills System — copy-on-enable, schema generation, and the disabled veto

A Skill in Kin is a YAML-frontmatter Markdown file (`SKILL.md`) that injects prompt context into a conversation. Skills are discovered by the SDK through directory scan. Kin manages them with three mechanisms: copy-on-enable, a disabled-skills veto list, and lazy schema generation for the Composer UI. This lesson explains why each exists and the trade-offs they create.

## The problem

Three requirements must be met at once:

1. Users must be able to toggle Skills on and off with one click.
2. The SDK must find enabled Skills as directories on disk, because it uses `settingSources: ['project']`.
3. The platform must be able to push a curated set of Skills to users by default, while still respecting a user's decision to opt out.

Requirements 2 and 3 together create a conflict: if the platform repeatedly syncs its curated Skills to every user, it will reopen Skills that the user has explicitly disabled. A mechanism is needed to let the platform push defaults while letting users permanently veto specific Skills.

## Why the naive options fail

- **Store Skills in a database**: the SDK does not read the database. It scans disk. Storing Skills in Postgres would require materializing them back to disk at runtime, which is wasted indirection.
- **Use symlinks instead of copies**: a symlink would make all users share the same source. If one user or the store updates a Skill, the change affects everyone. Skills need per-user isolation.
- **Force full platform sync every session**: this re-enables Skills the user disabled, creating a confusing user experience where a Skill keeps coming back after being turned off.

## The core design

> **Copy-on-enable, disabled veto, lazy schema generation. The platform can push defaults; users can veto individual Skills; the SDK sees only the filesystem truth.**

- **copy-on-enable**: `enableSkill()` copies `src/skills-store/<slug>/` into `~/.claude/skills/<slug>/`. Each user gets an independent copy. Re-enabling deletes the old copy first and copies the new one, which incidentally updates it to the latest store version.
- **disabled veto**: `disableSkill()` deletes the directory and writes the slug to `~/.claude/.disabled-skills.json`. Platform sync skips any slug in this file. This makes the user's "no" permanent while still allowing the platform to push new defaults.
- **lazy schema generation**: when a user clicks "generate form", Kin makes a separate SDK Structured Outputs call to extract up to six form fields from `SKILL.md`. The result is written as `.schema.json` and `.schema.meta.json` sidecar files with a `needsReview` flag. This is done outside the main conversation path so it does not add latency to every turn.
- **runtime injection**: `loadSkillContext()` reads `SKILL.md` and appends its content to the system prompt, giving the model a specific capability for the current turn.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/claude/skills/manager.ts` | ~L126–180 | `enableSkill` and `disableSkill` (copy, delete, veto list) |
| `src/claude/skills/store-seeder.ts` | — | Seed built-in Skills into `SKILLS_STORE_DIR` |
| `src/claude/skills/schema-generator.ts` | — | LLM extracts form fields into `.schema.json` + `.schema.meta.json` |
| `src/claude/skills/github-installer.ts` | — | Install Skills from GitHub ZIP archives |
| `ws-query-worker.mjs` | ~L100–124 | `loadSkillContext()` injects `SKILL.md` into the system prompt |

`enableSkill` performs delete-old → copy-new → remove-from-veto. `disableSkill` does the reverse: delete copy → add to veto. The veto list is the boundary between platform curation and user autonomy.

## The counter-intuitive conclusion

> **The conflict between platform defaults and user autonomy is resolved by a veto list, not a boolean switch.**

A boolean switch forces a question: "when the platform syncs, should it overwrite the user's switch?" A veto list avoids the question entirely. The platform pushes defaults; the user only records what they never want. The two mechanisms operate on different sets, so they never overwrite each other. Good arbitration does not pick a winner; it changes the game so both sides can win.

## Production pitfalls

- **copy-on-enable consumes disk linearly**: 100 users enabling the same Skill creates 100 copies. This is the cost of per-user isolation. The planned optimization is to keep the source in a database and materialize to disk lazily.
- **Schema generation output is unstable**: LLM-structured outputs vary. Kin normalizes many variants with a long set of branches. The `needsReview` flag is an honest admission that the generated schema is machine-created and should be checked by a human.
- **Enabled copies do not auto-update after the first enable**: if the store updates a Skill after a user has enabled it, the user's copy stays frozen until they re-enable. There is currently no version comparison to notify users of updates.

## Related Kin documentation

- `src/claude/skills/manager.ts` — enable/disable and veto logic
- `src/claude/skills/schema-generator.ts` — form schema generation
- `src/claude/skills/store-seeder.ts` — built-in Skill seeding
- `ws-query-worker.mjs` — `loadSkillContext()` runtime injection
- `07-mcp-capability-center.md` — filesystem enablement for MCPs

## Diagrams

1. `docs/blog/assets/img/08-skill-enable.svg` — Skill enable flow: store → copy → `~/.claude/skills` → SDK scan
2. `docs/blog/assets/img/08-disabled-veto.svg` — disabled veto versus platform sync
