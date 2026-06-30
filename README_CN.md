# Kin

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](.github/CODE_OF_CONDUCT.md)
[![Images](https://img.shields.io/badge/images-GHCR%20multi--arch-2496ed.svg)](https://github.com/deeptoai-com/kin/pkgs/container/kin%2Fapp)

> 中文文档 · English: [README.md](README.md)

**Kin 是面向小团队的自托管、单组织、多用户 Agent 工作台。** 在**你自己的基础设施**上，按你
选择的模型网关与预算，运行一个桌面级的完整 AI Agent——Skills、MCP、Artifacts、沙盒代码执行、
文档知识库（RAG）。没有厂商锁定。**你的文档、会话、审计记录都留在你自己的服务器**；模型调用
只发往**你选定的端点**（可以是你自有的 / 零留存网关）。Kin 是基于 API、provider 中立的——**并非
物理隔离（air-gap）**。

Kin 面向真实的团队场景：一圈可信的同事，自托管同一个共享工作台。它**不是**面向公网的匿名多租户
SaaS——安全采用纵深防御（组织内用户隔离、沙盒、误用护栏），而非对抗开放互联网的全面锁死。

## 亮点

- 🧰 **Skills 与 MCP**——一键启用/停用策展的 Skills 与 MCP 服务器；实时加载进 Agent 会话，
  无需重启。
- 👥 **Projects 与 branch-on-reply**——在项目内共享会话给成员；非 owner 回复会 fork 出新的分支会话，
  原始会话保持只读且归属清晰。
- 🎨 **Artifacts + 实时预览沙盒**——生成网页 / 文档 / React / SVG，并在每会话独立的沙盒容器里
  以独立子域名运行多文件 Web 应用。
- 🐍 **沙盒代码执行**——每会话隔离的运行时，用于代码、数据分析、自动化。
- 📚 **文档知识库（RAG）**——上传 PDF/文档，解析并嵌入到按会话隔离的可检索知识库；引用可点击。
- 🔀 **并发会话 / 后台续跑**——一个正在运行的对话会在后台继续，你可以同时开启另一个；正在运行
  的会话在侧栏有标记（ChatGPT/Claude 风格）。
- 🔎 **对话检索**——对消息正文做全文检索（不只是标题），直接跳转到命中的那条消息。
- ⬆️ **一键在线自动更新**——管理员在界面里升级正在运行的服务栈（拉取 → 迁移 → 重建 →
  健康闸门 → 失败自动回滚）。
- 🌐 **任意模型（provider 中立）**——指向**任意 Anthropic 兼容网关或你自己的端点**；ARK / 火山
  引擎只是默认值。GLM、DeepSeek、doubao、GPT、Qwen……取决于你的账号或网关暴露了什么；菜单只列
  探测健康的模型。不绑定任何单一厂商。
- 📦 **一条命令安装**——GHCR 上预构建的**多架构（amd64 + arm64）**镜像；一台全新 VPS 一条脚本
  即从零到一个 TLS 终止的运行栈。

## 快速开始

> Kin 向 GHCR 发布**预构建的多架构镜像**（`ghcr.io/deeptoai-com/kin/{app,parser,updater}`），
> 所以你不必在本地构建沉重的应用——安装脚本只负责拉取。

### 方案 A — 一条命令的 VPS 安装（公网 IP 主机）⭐

适用于一台全新、有公网 IP、域名托管在 Cloudflare 的 Ubuntu/Debian VPS。脚本会在缺失时安装
Docker，生成所有数据存储/认证密钥，只向你询问无法自动生成的内容（模型网关 key、域名、
Cloudflare DNS token），拉取镜像，在 Traefik + Let's Encrypt 后拉起服务栈，并等待其可服务。

```bash
git clone https://github.com/deeptoai-com/kin.git
cd kin
sudo bash scripts/install-vps.sh            # 交互式
# 或完全非交互：
#   sudo APP_HOSTNAME=kin.example.com ANTHROPIC_AUTH_TOKEN=... ANTHROPIC_BASE_URL=... \
#        ANTHROPIC_MODEL=... ACME_EMAIL=you@example.com CF_DNS_API_TOKEN=... \
#        bash scripts/install-vps.sh --yes
```

完成后，打开 `https://<your-domain>` 并注册第一个账号。

### 方案 B — Mac / 工作站 / NAT 之后（OrbStack + Cloudflare Tunnel）

无需公网 IP：一个 `cloudflared` 容器向 Cloudflare 打开一条出站隧道，于是同一套镜像就能跑在你的
Mac（OrbStack / Docker Desktop）或家用服务器上，并通过你的域名可达。详见
**[docs/deployment/tunnel.md](docs/deployment/tunnel.md)**。

```bash
git clone https://github.com/deeptoai-com/kin.git && cd kin
cp .env.example .env                         # 填入密钥 + APP_HOSTNAME + 模型网关
# 把你的隧道凭据放进 infra/tunnel/（见 docs/deployment/tunnel.md）
docker compose -f docker-compose.tunnel.yml -p kin up -d
```

> 专门的 `install-mac.sh` 在路线图上；目前 Mac 路径就是上面的隧道 compose。

### 方案 C — 本地开发

依赖服务（Postgres、Redis、MinIO、Meilisearch）跑在 Docker 里，应用作为本地 Node 进程运行。
详见 **[开发](#开发)** 与 `CLAUDE.md`。

```bash
git clone https://github.com/deeptoai-com/kin.git && cd kin
pnpm install
scripts/local-prod.sh --build                # 构建 + 在 http://127.0.0.1:3100 提供服务
```

## 在线自动更新

服务跑起来后，当有新镜像发布时，**管理员**会在侧栏看到一个**更新**入口。点一下就会运行完整的
应用流水线，由专门的 `updater` sidecar 执行（它永不重建自己——不会自杀）：

```
拉取新镜像 → 执行迁移 → 重建 worker → 重建 app → 健康闸门 → 完成
                                              └─ 失败时：自动回滚到上一个可用镜像
```

更新检查会把正在运行的构建 SHA 与最新发布的镜像比对；应用动作受管理员闸门 + token 鉴权保护。
详见 **[docs/deployment/overview.md](docs/deployment/overview.md)**。

## 架构

```
Browser ──WebSocket /ws/agent──▶ ws-server.mjs ──按会话 spawn──▶ ws-query-worker.mjs
   │                                  │                                └─ Claude Agent SDK query()
   │                                  ├─ Better Auth (cookie)              (沙盒、Skills、MCP)
   └─ TanStack Start (SSR + RPC)      ├─ 会话注册表（并发会话、按用户上限）
                                      └─ 按 sessionId 订阅 / 扇出
```

- **单一 Agent 运行时。** Kin 在 **Anthropic 兼容网关**（默认 ARK / 火山引擎）之上使用
  **Claude Agent SDK**——一套运行时，没有第二套 AI SDK。每个对话回合都跑在**自己的沙盒子进程**
  里；服务端在一条 WebSocket 上多路复用多个并发会话，你离开页面后后台运行仍会继续。
- **有状态流式。** 实时工具调用可视化、原生会话恢复、以及供侧栏使用的服务端权威运行态。
- **Worker 池与隔离。** 全局 worker 信号量加上**按用户并发上限**约束资源占用；空闲回收 +
  WebSocket 背压让单台主机保持健康。
- **Sidecar。** 一个 `parser` sidecar（PDF→Markdown，供 RAG 用）和一个 `updater` sidecar
  （在线自动更新）让应用镜像保持精简。

单入口对话位于 **`/agents/c`**（散会话）与 **`/agents/projects/*`**（项目级，支持成员共享与 branch-on-reply）。其它界面：
`documents`（知识库）、`skills`、`mcp`、`ocr`、`capabilities`、`settings`。

## 技术栈

| 层 | 技术 |
|-------|------------|
| **运行时** | Node.js 22+ |
| **Agent** | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)，运行在 Anthropic 兼容网关之上（默认 **ARK / 火山引擎**） |
| **框架** | [TanStack Start](https://tanstack.com/start)——全栈 React（SSR + 服务端函数） |
| **实时** | [`ws`](https://github.com/websockets/ws) WebSocket 服务器 + 按会话的 worker 进程 |
| **UI** | [shadcn/ui](https://ui.shadcn.com/) + Tailwind CSS v4、暗色模式、i18n（Intlayer） |
| **数据** | PostgreSQL + pgvector · [Drizzle ORM](https://orm.drizzle.team/) · Redis（BullMQ）· MinIO（S3）· Meilisearch |
| **认证** | [Better Auth](https://better-auth.com/)（邮箱/密码、OAuth） |
| **构建 / 部署** | Vite + Nitro · Docker Compose · GHCR 多架构镜像 · Traefik / Cloudflare Tunnel |

## 配置

把 `.env.example` 复制为 `.env` 并设置必需项。数据存储/认证密钥由 `install-vps.sh` 自动生成；
手动部署时自行设置。

```bash
# 模型网关（ARK / 火山引擎，或任意 Anthropic 兼容端点）
# ⚠️ 通过 ANTHROPIC_AUTH_TOKEN 用 Bearer token——不要同时设 ANTHROPIC_API_KEY。
ANTHROPIC_AUTH_TOKEN="<gateway-key>"
ANTHROPIC_BASE_URL="https://ark.cn-beijing.volces.com/api/coding"
ANTHROPIC_MODEL="<model-id>"

# 数据存储（由安装脚本自动生成）
POSTGRES_USER=... POSTGRES_PASSWORD=... POSTGRES_DB=...
MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... MINIO_BUCKET=...
MEILI_MASTER_KEY=...

# 认证
BETTER_AUTH_SECRET="<random>"
APP_HOSTNAME="kin.example.com"

# 可选功能
RAG_ENABLED=true            # 文档知识库（需要 parser sidecar）
PER_USER_MAX_WORKERS=3      # 每用户并发运行会话数
```

`VITE_WS_URL` **不会**烤进镜像——前端在运行期自算 `wss://<current-host>/ws/agent`，所以同一个
镜像适配任意域名。完整清单见 `.env.example`。**永远不要提交 `.env`。**

## 容量与并发

每个对话回合跑在一个隔离的 worker 里（**活跃时约 0.5–0.6 GB**，实测；Node 堆在大型生成时可能增长到 1.5 GB 上限）。消耗资源的是**同时执行**的 worker 数量，而非打开的会话数。Kin 用**全局 worker 信号量**（默认 8）和**按用户上限**（`PER_USER_MAX_WORKERS`，默认 3）来约束它；超额的运行进入队列。一次负载测试显示 **8 个并发 worker 峰值约 5 GB**，并干净回到空闲（无泄漏），所以一台 **16 GB / 8 核**主机能从容服务一个小团队。详见 **[docs/deployment/sizing.md](docs/deployment/sizing.md)**。

## 开发

```bash
pnpm install
scripts/local-prod.sh --build   # 构建 + 提供服务（http://127.0.0.1:3100）；依赖跑在 Docker

# 质量闸门
pnpm typecheck
pnpm lint
pnpm validate-routes
pnpm test
```

> 注：`pnpm dev`（Vite HMR）当前被一个 nitro-nightly bug 卡住——本地运行请用
> `scripts/local-prod.sh`。详见 `CLAUDE.md`。

## 部署文档

- **[总览](docs/deployment/overview.md)**——路径、镜像、在线自动更新
- **[VPS（公网 IP）](scripts/install-vps.sh)**——一条命令的安装脚本
- **[隧道（Mac / NAT）](docs/deployment/tunnel.md)**——Cloudflare Tunnel
- **[容量](docs/deployment/sizing.md)**——主机选型与并发

## 许可证

**[Apache License 2.0](LICENSE)**——可自由使用、修改、自托管、二次开发，**含商业用途**（带显式
专利授权）。本仓库的全部内容都在此协议下。

Kin 采用**开核（open-core）**模式：核心永久 Apache-2.0、免费开放；面向企业的**定制插件模块**作为
可选的付费增值单独提供（不在本仓库内），你无需任何付费模块即可运行 Kin。见 [LICENSING.md](LICENSING.md)。

Kin 构建于 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 之上，受
[Anthropic 商业条款](https://www.anthropic.com/legal/commercial-terms)约束；完整第三方归属见
[NOTICE](NOTICE)。

## 链接

- **仓库**：https://github.com/deeptoai-com/kin
- **容器镜像**：https://github.com/deeptoai-com/kin/pkgs/container/kin%2Fapp
- **贡献**：[CONTRIBUTING.md](.github/CONTRIBUTING.md) · **安全**：[SECURITY.md](.github/SECURITY.md)
