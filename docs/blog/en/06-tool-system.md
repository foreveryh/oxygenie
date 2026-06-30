---
title: "Tool System — SDK preset claude_code and custom MCP tools"
slug: 06-tool-system
date: 2026-06-07
keywords: [claude_code preset, createSdkMcpServer, MCP, Python tool, Bash tool]
---

# Tool System — SDK preset `claude_code` and custom MCP tools

Kin's tools fall into two categories. The first is the SDK's built-in `claude_code` preset (Read, Write, Edit, Grep, Glob, and others). The second is custom tools registered via `createSdkMcpServer` — Python, GLM-Image, and Bash. This lesson explains the division of labor: which tools are left to the SDK, which are wrapped by Kin, and why Bash in particular is wrapped rather than used as-is.

## The problem

A useful agent needs to read, write, edit, search, run code, generate images, and execute shell commands. But in a self-hosted, multi-user environment, not every tool has the same risk profile:

- **Read/Write/Edit/Grep** are dangerous mainly because they can cross workspace boundaries. Their execution itself does not require special handling.
- **Bash/Python** are dangerous because they execute arbitrary code. The moment of execution must be intercepted so the command can be placed inside a sandbox, secrets stripped, and resource limits applied.

The question is not whether to use the SDK's tools. It is which tools can be trusted to the SDK as-is, and which need a custom wrapper that sends execution through `ExecutionRuntime`.

## Why the naive options fail

- **Use the SDK preset including native Bash**: the SDK's native Bash runs commands inside the agent loop without any hook. There is no way to route the command through `ExecutionRuntime`, no `buildSafeEnv()` to strip secrets, and no `prlimit` to cap resources. This delegates the most dangerous capability to an uncontrolled executor.
- **Disable Bash and let the model use Python `subprocess`**: the model will still run shell commands, but through a less transparent path that is harder to gate and audit. This hides danger instead of removing it.
- **Rewrite every tool yourself**: Read, Edit, Grep, and the other preset tools already include boundary checks and follow the SDK's tool-calling format. Rewriting them is duplication and creates a risk of mismatching the SDK's schema.

The correct dividing line is whether Kin needs to intervene **at the moment of execution**.

## The core design

> **Use the SDK preset for tools that do not need execution interception. Use custom MCP tools for tools that must be routed through `ExecutionRuntime`. Native Bash is always disabled; Bash is only available through the custom `mcp__bash__run` tool, which is gated by sandbox readiness.**

```javascript
// ws-query-worker.mjs
const pythonMcp = createSdkMcpServer({ name: 'python', tools: [ pythonTool ] })
const glmImage  = createSdkMcpServer({ name: 'glm-image', tools: [ glmImageTool ] })
const bashMcp   = sandboxReady ? createSdkMcpServer({ name: 'bash', tools: [ bashTool ] }) : null

query({
  options: {
    tools: { type: 'preset', preset: 'claude_code' },
    mcpServers: [pythonMcp, glmImage, ...(bashMcp ? [bashMcp] : []), ...userMcp]
  }
})
```

Key points:

- **Preset tools stay in the SDK**. They are free, maintained by Anthropic, and already include workspace-aware validation. Their security in Kin is layered on top through `path-security.js` and `canUseTool`.
- **Custom execution tools route through `ExecutionRuntime`**. Python, Bash, and image generation all execute inside the runtime abstraction, so they receive sandboxing, secret stripping, and resource limits.
- **Bash is conditionally registered**. If the sandbox is not ready (`sandboxReady` is false), Bash is not exposed to the model at all. There is no fallback to native Bash.
- **All tools pass the same pre-gate**. Regardless of source, every tool call is checked by `canUseTool` and the path-security layer.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `ws-query-worker.mjs` | ~L383–629 | Register Python / GLM-Image / Bash MCPs and merge user MCPs |
| `src/claude/python/runner.js` | ~187 | Python execution through `ExecutionRuntime` + workspace snapshot |
| `src/claude/bash/runner.js` | ~241 | Bash validation + `prlimit` + FAIL-CLOSED |
| `src/claude/path-security.js` | ~L267–331 | Workspace / user boundary checks for file tools |

Execution-class tools have hardwired guardrails that are part of their safety contract: Python 10 s timeout, Bash 300 s timeout, output cap 512 KB, Python code size cap 200 KB, and workspace snapshot truncated at 2000 files. These numbers are policy, not tuning. They define how much a runaway command can consume before it is stopped.

## The counter-intuitive conclusion

> **The boundary between "use the SDK" and "build custom" is not feature completeness. It is whether you need an interception point before execution.**

Bash needs an interception point, so even though the SDK provides native Bash, Kin wraps it. Read/Edit/Grep do not need that interception, so Kin uses the SDK preset. This is the principle of "do not rewrite what the SDK already does well, but do build a wrapper when the SDK does not expose the hook you need."

## Production pitfalls

- **Bash silently disappears when the sandbox fails**. If `sandboxReady` is false, the Bash MCP is not registered. The conversation continues, but the model has no Bash tool. This is intentional, but it can be mistaken for a model bug. Monitor `sandboxReady` in production logs.
- **Python output over 512 KB is SIGKILL, not truncation**. When the cap is exceeded, the process is killed rather than truncated. The model sees a dead process and may retry the same code. This protects the pipe but requires clear prompts about paging output.
- **Workspace snapshots are disabled above 2000 files**. If a workspace grows larger than 2000 files (for example, `node_modules` is not ignored), the post-execution diff feedback is turned off. The model may not know what files it changed, leading to repeated or misdirected operations. Workspace hygiene is a correctness requirement, not a preference.

## Related Kin documentation

- `ws-query-worker.mjs` — MCP and preset registration
- `src/claude/python/runner.js` — Python execution and snapshot
- `src/claude/bash/runner.js` — Bash execution and hard limits
- `src/claude/path-security.js` — path boundary checks
- `05-execution-runtime.md` — `ExecutionRuntime` abstraction and FAIL-CLOSED
- `10-bash-sandbox.md` — Bash-specific hardening

## Diagrams

1. `docs/blog/assets/img/06-tool-split.svg` — split between preset and custom MCP tools
