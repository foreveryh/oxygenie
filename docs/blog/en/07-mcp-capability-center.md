---
title: "MCP Capability Center — built-in MCPs, per-user FS enablement, credentials, and overrides"
slug: 07-mcp-capability-center
date: 2026-06-07
keywords: [MCP, Model Context Protocol, per-user enablement, credentials, overrides]
---

# MCP Capability Center — built-in MCPs, per-user FS enablement, credentials, and overrides

MCP servers let external tools plug into the agent. Kin ships a curated set of built-in MCPs and lets each user decide which ones to enable. This lesson explains why enablement state lives in per-user filesystem JSON rather than a database, how credentials and tool overrides are managed, and why connection lifecycle is delegated to the SDK.

## The problem

In a multi-user workspace, not every user needs the same MCPs. One user needs search and vision; another only needs Python and image generation. Each user may have their own API keys. Advanced users may want to allow only a subset of an MCP's tools. Three kinds of state must be managed:

1. **Enablement**: which MCPs are active for this user.
2. **Credentials**: which API keys or tokens each MCP uses.
3. **Overrides**: which tools within an MCP are allowed.

A fourth concern is the runtime lifecycle of MCP connections: who connects, reconnects, and reports status?

## Why the naive options fail

- **Store enablement in a database**: the SDK does not read Postgres. It discovers MCP configuration by scanning `settingSources` on disk. Even if enablement were in a database, the runtime would still have to materialize it back to disk, making the database a pointless middleman.
- **Write your own MCP connection manager**: the SDK 0.2.112 already provides `toggleMcpServer`, `reconnectMcpServer`, and `mcpServerStatus`. Reimplementing these duplicates the SDK's internal state and introduces drift.
- **Combine credentials, enablement, and overrides in one file**: rewriting the whole file for one small change creates concurrency hazards and mixes data with different security requirements.

## The core design

> **Per-user filesystem JSON for state, SDK for connections. Three files: `enabled.json`, `credentials.json`, and `overrides.json`.**

- `~/.claude/mcp/enabled.json` — the list of enabled MCPs.
- `~/.claude/mcp/credentials.json` — credentials such as API keys, using `${VAR}` template substitution.
- `~/.claude/mcp/overrides.json` — optional `allowedTools` filters per MCP.

Built-in MCPs live in `src/mcp-store/` and include glm-image, python, markitdown-mcp, and several Zhipu services (search, vision, reader, zread). They are a curated team toolkit, not a public marketplace.

Kin is responsible for configuration. The SDK is responsible for connection, reconnection, and status reporting. The `system.init` event reports each MCP's connection state and tool count, which the UI uses to render the capability center.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/claude/mcp/manager.js` | ~L45–55 | `getUserClaudeHome()` resolves the user's `.claude` root |
| `src/claude/mcp/manager.js` | read/write | `enabled.json` CRUD |
| `src/claude/mcp/manager.js` | ~L85–194 | `getMcpCredentials`, `setMcpCredentials`, allowed-tools overrides |
| `src/mcp-store/*` | 7 directories | Built-in MCP sources |

The manager translates enabled MCPs into the `mcpServers` array the SDK consumes. From that point on, the SDK owns the connection.

## The counter-intuitive conclusion

> **"Which MCPs are enabled" is a user preference, not relational data, so it belongs in the filesystem.**

The SDK is the consumer, and it reads by directory scan. Putting preferences in a database would only add a translation layer from SQL to disk. The decision criterion is who reads the data, not how important it is. This same principle applies to Skill enablement.

## Production pitfalls

- **MCPs are not pre-warmed**: connections happen at session start. A user with many MCPs can experience a first-message delay, especially if an MCP endpoint is slow or unreachable.
- **Credentials are currently stored in plaintext on disk**: `credentials.json` contains API keys in plain text. In the semi-trusted colleague threat model, this is a real exposure. The planned migration is to store credentials encrypted in the database and keep enablement as filesystem preferences.
- **Tool overrides are not runtime-enforced in SDK 0.2.112**: the `allowedTools` field is honored only in newer SDK versions. With Kin pinned to 0.2.112, overrides are mostly a UI-level declaration. The built-in MCPs are curated by the team; overrides are not a security boundary against untrusted MCPs.

## Related Kin documentation

- `src/claude/mcp/manager.js` — MCP configuration and enablement
- `src/mcp-store/` — built-in MCP sources
- `06-tool-system.md` — custom MCP tools and the SDK preset
- `08-skills-system.md` — filesystem enablement for Skills

## Diagrams

1. `docs/blog/assets/img/07-mcp-center.svg` — MCP capability center: 7 built-ins + per-user FS enablement + SDK-managed connections
