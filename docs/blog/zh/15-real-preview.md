---
title: "真预览 — 在 per-session Docker 中运行 AI 生成的多文件 App"
slug: 15-real-preview
date: 2026-06-07
keywords: [AI artifact, 真预览, per-session Docker, Traefik, 子域代理, bootstrap JWT, iframe sandbox]
---

# 真预览 — 在 per-session Docker 中运行 AI 生成的多文件 App

一个严肃的 AI 工作台必须能运行它生成的代码，而不只是显示它。Kin 的预览不是 iframe 覆盖层或浏览器沙箱。它是一个真正的 per-session Docker 环境，安装依赖、构建项目，并通过子域认证把结果 serve 出来。本课解释四段管线，以及在与主应用同一台机器上托管不受信任生成代码时涉及的权衡。

## 问题

真预览必须同时满足四个相互竞争的需求：

1. **多文件、真实构建**：AI 输出通常是完整 Vite/React 项目，带 `package.json` 和 `src/**`。需要真实的 `npm install` 和 `npm run build` 才能暴露真实构建错误、真实依赖和真实路由。
2. **资源有界**：50 个活跃会话不能各自保持一个 Node dev server 运行；那会让 16 GB 主机 OOM。
3. **安全**：代码由用户通过模型生成。它不能读取其他用户文件、外泄 secret，或充当内部网络 pivot。
4. **浏览器可嵌入**：预览必须在聊天 UI 的 iframe 中可见，因此需要公共 URL、认证和可用的 HMR websocket。

渲染生成输出不是前端问题；而是微型 PaaS 问题。

## 为什么朴素方案失败

- **Sandpack / WebContainers**：基于浏览器的沙箱无法运行真实 `npm install` 安装任意依赖，无法暴露真实构建错误，也无法运行纯 Node 后端代码。它们适合 demo，但不足以处理真实工程输出。
- **每个 artifact 一个 dev server**：每个 artifact 保持一个 live dev server，内存消耗与会话数和 artifact 数成正比，很快超过主机预算。
- **子路径反代 (`/preview/<id>/...`)**：Vite HMR 和相对导入在 base path 被重写时会断。需要一级子域。
- **为每个预览动态 Let's Encrypt 证书**：Cloudflare 免费版只覆盖一级通配符，Full(Strict) 模式会阻止 HTTP-01 验证。动态签发在这种部署形态下不现实。

## 核心设计

> **Per-session 持久 Docker（不是 per-message，也不是 per-artifact）+ build-first 静态托管 + Traefik 子域代理 + Cloudflare Origin CA + bootstrap JWT → cookie 认证 + idle reaper。**

```
① 检测与 manifest    ② 构建与托管            ③ 代理与暴露       ④ 认证与嵌入
manifest.js            preview controller     Traefik            auth.js
扫描 package.json      （仅 Docker socket）    *.oxygenie.cc     /preview?t=<JWT 90s>
→ .oxygenie/app.json   per-session 容器      HostRegexp 路由    → /__oxy/auth
install/build/dev/port install→build→serve   Origin CA 证书     → oxy_preview cookie
entryFiles             idle 5–10 min 回收    dynamic labels     → iframe sandbox
                       MAX_ACTIVE_PREVIEWS=4
```

- **Manifest 检测**：启发式扫描项目，识别框架、入口点、端口，产出 `.oxygenie/app.json`。只执行声明的 `package.json` scripts；不给模型自由 shell。
- **构建与托管**：per-session Docker 容器跨消息持久，以维持温暖的 `node_modules` 缓存。管线是 build-first，dev/HMR 是尽力而为。`MAX_ACTIVE_PREVIEWS=4` 和 idle timeout 保持资源使用有界。
- **代理暴露**：每个预览通过 Traefik `HostRegexp` 获得 `<previewId>.oxygenie.cc`。单个 Cloudflare Origin CA 证书一次签发、所有路由复用，绕过动态签发问题。
- **认证**：首次访问时，60–120 秒 bootstrap JWT 换取 10–15 分钟 `httpOnly` 不透明 `oxy_preview` cookie。iframe 使用 `sandbox="allow-scripts allow-forms allow-downloads"`，不含 `allow-same-origin`，与主站 origin 隔离。

## 关键实现点

| 文件 / 设置 | 值 / 行号 | 机制 |
|---|---|---|
| `src/preview/runtime.js` | ~L5–10 | `MAX_ACTIVE_PREVIEWS=4`、`PREVIEW_IDLE_TIMEOUT_MS=600000` |
| `src/preview/runtime.js` | ~L33–40 | 稳定 `previewId` 来自 `hash(sessionId + appKey)`，避免重复容器 |
| `src/preview/controller.mjs` | — | 唯一持有 Docker socket 的组件 |
| `src/preview/auth.js` | ~L3–5 | bootstrap JWT 90s，不透明 cookie 15 min |
| `docker-compose.dokploy.yml` | ~L396–421 | preview-controller 服务 |

## 状态：已交付，但有一个剩余架构张力

Phase C（真预览）已交付并上线。预览管线功能完整，包括 build-first 静态 serve、Traefik 子域路由、Origin CA 证书、JWT/cookie 认证。

剩余的是一个**运行时架构张力**：agent 在 per-message worker 中执行，而 preview 在 per-session 容器中运行。这是两个不同生命周期，目前共享同一 workspace 但未统一。如果 agent 写文件，preview 容器必须能看到，反之亦然。共享 workspace 是耦合点。统一两个运行时——无论是通过 warm workspace pool 还是消除区别——是长期架构债务，不是功能性 bug。

## 反直觉结论

> **渲染 AI 生成的 App 不是前端问题，而是微型 PaaS 问题。**

真正的工程在于 Docker 生命周期、Traefik 路由、证书管理、cookie 认证和 idle 回收。iframe 只是最后 1%。预览系统也复用了 Kin 的现有隔离哲学：有界并发、进程/容器边界、build-first 无状态执行。

## 生产坑

- **Traefik v3 `HostRegexp` 语法和 YAML 转义非常苛刻**。一个转义错误就会静默 404。启用通配符模式前先用固定子域测试。
- **Agent 和 preview 运行时未统一**。注意 workspace 文件必须对 per-message worker 和 per-session preview 容器都可见。
- **Artifact 检测的结构化输出路径默认关闭**。SDK `outputFormat` 的 stop-hook 会把内部指令泄漏到对话上下文，因此 artifact 检测保持启发式，以 `.oxygenie/app.json` 为稳定真相。

## 相关 Kin 文档

- `src/preview/runtime.js` — 预览并发与 idle 跟踪
- `src/preview/controller.mjs` — Docker 编排
- `src/preview/auth.js` — 认证流程
- `docker-compose.dokploy.yml` — preview-controller 服务
- `zh/16-artifacts-and-workbench.md` — artifact 检测与会话 UI
- `zh/19-dokploy-deploy.md` — Traefik 与 Origin CA 部署

## 配图

1. `docs/blog/assets/img/15-preview-pipeline.svg` — 四段预览管线
2. `docs/blog/assets/img/15-preview-auth.svg` — bootstrap JWT → cookie 认证流程
3. `docs/blog/assets/img/15-two-runtimes.svg` — per-message worker vs per-session preview 容器
