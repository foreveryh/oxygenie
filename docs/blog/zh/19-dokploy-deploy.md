---
title: "Dokploy 部署 — 多阶段 Docker、GHCR、Traefik 子域与 Cloudflare Origin CA"
slug: 19-dokploy-deploy
date: 2026-06-07
keywords: [Dokploy, Docker, GHCR, Traefik, Cloudflare Origin CA, CI/CD]
---

# Dokploy 部署 — 多阶段 Docker、GHCR、Traefik 子域与 Cloudflare Origin CA

所有 Kin 运行时组件必须能在 16 GB VPS 上一键重新部署。本课描述部署链：多阶段 Docker 镜像、GitHub Actions 在 amd64 上预构建、GHCR 推送、Dokploy Compose 编排、Traefik 子域路由，以及 Cloudflare Origin CA 证书。

## 问题

五个约束必须同时满足：

1. 从 git push 一键重新部署。
2. 构建不能在免费 CI runner（约 7 GB）上 OOM。
3. 构建架构必须匹配生产 amd64 主机。
4. 每个预览必须能通过一级子域 + HTTPS 访问。
5. 大约十个服务（Traefik、Postgres、Redis、MinIO、Meilisearch、app、ws-server、migrations、worker、preview-controller）必须一起编排。

## 为什么朴素方案失败

- **直接在 Dokploy 主机构建**：SSR 构建消耗太多内存，并与运行中的服务竞争。也慢且浪费。
- **在 Mac 上本地构建**：产出 ARM64 镜像，无法在 amd64 生产主机上运行。
- **为预览子域动态 Let's Encrypt**：Cloudflare Full(Strict) 模式会阻止 HTTP-01 验证，免费版通配符只覆盖一级。
- **在镜像中保留 Playwright 和 LibreOffice**：增加约 2 GB 镜像，加大 CI 构建内存和磁盘压力。
- **使用 Kubernetes**：对单机器、约 50 会话目标来说过度复杂。

## 核心设计

> **在 GitHub Actions 中预构建 amd64 镜像，推送到 GHCR，让 Dokploy 用 `pull_policy: always` 拉取。使用精简到约 1.5 GB 的多阶段 Dockerfile。用单个 Dokploy Compose 文件编排。通过 Traefik 路由子域，使用单个 Cloudflare Origin CA 证书。**

- **多阶段 Dockerfile**：builder 阶段用 8 GB 内存跑 Vite 构建；runner 阶段只安装 Python、bubblewrap、socat、pandoc，以非 root `nodejs` 用户运行。移除 Playwright 和 LibreOffice 后，镜像从约 3.5 GB 降到约 1.5 GB。
- **GitHub Actions amd64 构建**：`.github/workflows/build.yml` 在 `linux/amd64` 上构建，推送到 `ghcr.io/.../app:{SHA}` 和 `:latest`。这避免了主机内存压力和架构不匹配。
- **Dokploy Compose 的 `pull_policy: always`**：所有使用 app 镜像的服务都必须设置 `pull_policy: always`。默认 `missing` 不会替换本地镜像，当发布新 digest 时不会拉取，破坏一键重新部署。
- **Traefik + Cloudflare Origin CA**：预览子域通过 Traefik `HostRegexp` 使用单个 Origin CA 证书，覆盖 `*.oxygenie.cc`。这同时避免了 HTTP-01 验证问题和单级通配符限制。
- **统一启动脚本**：`start-production.mjs` 在同一个容器内启动 Nitro（端口 5000）和 WebSocket 服务器（端口 3001），因此 Compose 只需管理一个 app 服务。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `Dockerfile` | ~L2–54 / L55–148 | builder（8 GB Vite 构建）/ runner（非 root、Python、沙箱工具） |
| `.github/workflows/ci.yml` | ~L43–72 | lint/unit 硬 gate、integration 非阻塞、8 GB 构建 |
| `.github/workflows/build.yml` | ~L21–44 | amd64 构建 → GHCR `:SHA` + `:latest` |
| `docker-compose.dokploy.yml` | ~L20–21 / L117 / L396–421 | `pull_policy: always`、`ANTHROPIC_AUTH_TOKEN`、preview-controller |
| `start-production.mjs` | — | 同一容器内启动 Nitro + ws-server |

## 反直觉结论

> **自托管 agent 的一半工程都在绕过 CDN 和构建环境的怪癖。**

Dockerfile 不是难点。难点是部署时才发现的：Cloudflare 证书限制、CI 内存限制、开发者笔记本与生产环境之间的架构不匹配、Compose 的默认拉取策略。部署的价值不是运行中的容器，而是把发现的约束编码成可重复的 Compose 和工作流文件。

## 生产坑

- **使用 Docker Compose 时不要在 `.env` 中设置 `DATABASE_URL`**。Compose 从 `POSTGRES_*` 构造 `DATABASE_URL`。手动设置会指向 `localhost` 并破坏 migrations。
- **Traefik v3 的 `HostRegexp` 语法与 v2 不同**。YAML 转义和 compose 插值（`$` → `$$`）也容易出错。启用通配符模式前先用固定子域测试。
- **ARK 场景下只使用 `ANTHROPIC_AUTH_TOKEN`**。`ANTHROPIC_API_KEY` 会改变认证头，导致 401。
- **私有 GHCR 包需要在 Dokploy 中配置 registry 凭据**。否则拉取会静默 403 失败。
- **`depends_on: healthy` 不能保证 `db` 服务的 DNS 解析**。Migrations 必须重试直到数据库可达。

## 相关 Kin 文档

- `Dockerfile` — 镜像构建
- `.github/workflows/build.yml` — CI 镜像构建
- `docker-compose.dokploy.yml` — 生产编排
- `start-production.mjs` — 容器启动
- `zh/15-real-preview.md` — 预览子域与 Origin CA
- `docs/deployment/` — 部署指南

## 配图

1. `docs/blog/assets/img/18-deploy-pipeline.svg` — CI → GHCR → Dokploy → Traefik
2. `docs/blog/assets/img/18-cf-origin-ca.svg` — Cloudflare Origin CA + 一级通配符
