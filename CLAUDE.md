# Kin - 开发规则

> 历史品牌：本项目早期称为 **OxyGenie**，仍保留 `oxygenie.cc` 作为生产域名（Owner
> 2026-06-12 确认），但代码仓库、GHCR 镜像、README/官方文案均已迁移到 **Kin /
> Deeptoai-com**。文中出现 `oxygenie.cc` / `oxygenie-cc2-private` 等字样是**真实部署事实**
> 或**历史坑点**，并非待改的"品牌错位"——请勿盲改。

## 产品定位与设计前提（北极星 · 任何设计/功能先对照此处，避免偏差）

**Kin 是面向中小团队的「私有化部署」自治 Claude-Agent 工作台。** 典型场景：**公司内部 / 团队内部**，由**可信的小圈子（同事）自托管使用**——这也是我们鼓励的用法。它是**自托管、单组织、多用户（组织内多个可信用户）**的产品，**不是**面向公网匿名大众的多租户 SaaS。

**设计自检（每次做设计/功能前对照；若与下列前提冲突，停下来与 Owner 确认）：**
1. **威胁模型 = 半可信同事，不是匿名攻击者。** 安全是「防误操作 + 共享宿主/密钥卫生 + 组织内用户隔离」的**纵深防御**，**不是**反匿名攻击的锁死。**触达服务器的强力功能（stdio MCP、连内网/本地工具、代码执行）是合法核心用途**——用沙盒 + 警示护栏，而非禁止。
2. **能力是给团队自己用的精选集，不是公开市场。** Skills/MCP 为相对固定的精选，**无评分/付费/公开市场**（上游 API 只做候选来源，由团队策展）。
3. **必须跑在团队选用的模型/网关上。** 默认 **ARK（火山）多模型网关**；Claude Agent SDK 钉死在 ARK 兼容上限 **0.2.112**。**不要设计依赖「仅原生 Anthropic」的 SDK 0.3.x 特性**，除非先有明确的网关/迁移决策。
4. **可部署性优先于超大规模。** 为「团队 Docker 一键起跑、开箱即用」优化，而非弹性公网 SaaS 规模。

> 完整论述见 `docs/project/VISION.md` §1。此定位为**已定（2026-06）**，变更需明确的战略决策。

## 项目背景

本项目基于 **TanStack Start** 构建，提供 SSR、路由、服务端函数等现代全栈能力。

### Agent 运行时（单一 SDK）

项目**只用 Claude Agent SDK**（交互式聊天 + 代码执行 + 真预览，经 WebSocket 持久连接、
子进程隔离、Per-Session 沙盒、原生会话恢复）。**Mastra 已于 2026-06 彻底移除**（连同
playwright / libreoffice，瘦身以恢复免费 CI 构建）——不要再引入第二套 Agent SDK / Vercel
AI SDK（`ai` / `@ai-sdk/*`），如需新增 LLM 网关能力走「多模型」路线（见 ROADMAP「Later」）。

### MCP (Model Context Protocol) 状态

- **运行时注入已真实可用**：`resolveMcpServerConfigs`（`src/claude/mcp/manager.js`）在 worker 内把
  `mcpServers` 传给 SDK `query()`（sdk/stdio/http/sse 四类，见 `ws-query-worker.mjs`），session
  metadata 暴露 `mcp_servers`。不要把下一条误读成"MCP 没做"。
- 待完善的是**策展目录/选择器 UI**（团队精选集管理），见 ROADMAP「Next」。

---

## 项目状态

本项目基于 **TanStack Start** 构建。

**GitHub 仓库**: https://github.com/deeptoai-com/kin

**已完成的功能 (Phase 1-4)**:
- Phase 1: WebSocket 服务器 + Claude Agent SDK 集成
- Phase 2: 用户隔离（Child Process + Docker 容器化）
- Phase 3: Per-Session Sandbox（每会话独立配置目录）
- Phase 4: 前端集成（Session 列表、Resume、标题管理）

## 开发目录规则

**正确的开发目录**: 项目根目录（仓库 clone 后的目录）

**禁止在以下目录开发**:
- 父目录（仅用于文档和参考）
- 其他项目目录（原始参考代码等）
- 任何临时开发目录（如历史 phase 目录，已清理）

## 项目结构

```
OxyGenie/  # 历史名；目录结构指代当前仓库根
├── src/
│   ├── components/claude-chat/   # Claude Chat UI 组件
│   ├── lib/                      # 工具库和适配器
│   ├── routes/                   # TanStack Router 路由
│   ├── server/                   # 服务端逻辑
│   └── db/                       # 数据库 schema
├── ws-server.mjs                 # WebSocket 服务器入口
├── ws-query-worker.mjs           # Worker 进程
├── docker-compose.yml            # Docker 部署配置
└── Dockerfile                    # 容器镜像定义
```

## 技术栈

- **前端**: TanStack Start + React + Assistant UI
- **后端**: WebSocket Server + Claude Agent SDK
- **数据库**: PostgreSQL + Drizzle ORM
- **认证**: Better Auth
- **部署**: Docker Compose

## 开发命令

```bash
# ── 本地运行（生产构建，连共享 Docker 后端）── 详见「## 本地运行环境」
scripts/local-prod.sh --build      # 首次/改完代码：建桥 + 构建 + 启动 → http://127.0.0.1:3100
scripts/local-prod.sh              # 之后免构建重启
scripts/local-backend.sh down      # 收工：删桥 + 删 .env.local

# ⚠️ pnpm dev（vite 热更）当前不可用 —— nitro-nightly dev 运行时 bug
#    （Missing `fetch` export，每页 500）。修复前本地一律走上面的 local-prod。

# WebSocket 服务器（如需，开发/生产统一）
node ws-server.mjs

# Docker 部署
docker compose up -d
```

## 本地运行环境（共享 Docker 后端）

> 目标：在**宿主机**上跑本地构建的应用，**复用正在运行的 Docker 后端栈**（同一个
> Postgres / Redis / 数据），改完能本地验证 —— 且**不碰你的栈、不改 `.env`、不动共享库
> schema**。流程已固化为 `scripts/`，全员统一用法。

### 为什么要桥接
后端容器（`oxygenie-db` / `oxygenie-redis` / …）跑在内部 Docker 网络上、**不向宿主机映射
端口**，宿主机进程直接连不上（`localhost:5432` 无人监听、`redis` 主机名解析不了）。`scripts/`
用 `socat` 旁路容器接到同一网络、把内网服务发布到宿主机端口（`db→15432`、`redis→16379`），
再用 **`.env.local`（gitignored）** 覆盖把应用指过去。**全程不动现有容器、不动 `.env`。**

### 一条命令跑起来
```bash
scripts/local-prod.sh --build      # 首次 / 改完代码：建桥 + 生成 .env.local + 8G 堆构建 + 启动
scripts/local-prod.sh              # 之后免构建重启
# → 打开 http://127.0.0.1:3100 ，注册一个用户即可（邮箱验证默认关，注册即登录）
scripts/local-backend.sh down      # 收工清理：删桥 + 删 .env.local
```
- `scripts/local-backend.sh up|down`：socat 桥 + 生成/删除 `.env.local`。连接串从运行中的
  `oxygenie-app` 容器读取（**凭据永远匹配**），自动发现 Docker 网络。
- `scripts/local-prod.sh [--build]`：（必要时自动建桥）+ 构建 + 起生产 Nitro 服务。

### 铁律（脚本已内建，手动操作也要遵守）
- **只写 `.env.local`，永不改 `.env`**：Vite `loadEnv` 会让 `.env.local` 覆盖 `.env`
  （`vite.config.ts:14` 的 `Object.assign(process.env, loadEnv(...))`）。`.env.local` 已 gitignored。
- **`AUTO_MIGRATE=false`**：本地跑**不对共享库做迁移**，schema 安全。
- **构建要 ≥8 GB 堆**：SSR 打包峰值 ~4 GB，默认 heap 会 OOM。脚本已带
  `NODE_OPTIONS=--max-old-space-size=8192`；手动 `pnpm build` 也务必加。
- **`BETTER_AUTH_URL=http://127.0.0.1:3100`**：让 better-auth 信任本地源、并用非 secure
  cookie（否则 http 下注册/登录会 403 `INVALID_ORIGIN` 或会话不保持）。脚本已设。

### ⚠️ 热更（`pnpm dev`）当前不可用 —— 已知问题
`vite dev` 的 SSR 运行时被 `nitro`（package.json 里 = `nitro-nightly@latest`，锁定版
`3.0.0-20250925`）的 bug 卡死：**`Missing 'fetch' export in nitro-dev.mjs`**，每个页面 500。
这就是下面「禁止 `pnpm dev`」的根因。**修复前，本地一律用 `scripts/local-prod.sh`（无热更，
改完重新 `--build`）。** 恢复热更 = 换一个 dev 能跑的 nitro 版本（动 lockfile / 构建依赖，
按「Docker 修改规则」需单独评估，别顺手改）。

## Git 工作流

- 主分支: `main`
- 远程仓库: `origin` → https://github.com/deeptoai-com/kin
- 直接在 `main` 分支开发，或创建 feature 分支后合并

---

## Claude Agent SDK 集成

### 版本信息
- `@anthropic-ai/claude-agent-sdk`: `0.2.112`（精确钉死；**勿用 `^`/`~`** —— 0.2.113+ 改为原生二进制，与 ARK 网关不兼容会卡死。详见 `docs/project/research/2026-06-skills-existing-architecture-and-redesign.md` §九）

### 核心文件

| 文件 | 职责 |
|------|------|
| `ws-server.mjs` | WebSocket 服务器主入口，处理认证、会话管理、进程生命周期 |
| `ws-query-worker.mjs` | 子进程 Worker，调用 SDK 的 `query()` 函数 |
| `src/claude/adapters/ws-adapter.ts` | 前端 WebSocket 适配器，将 SDK 事件转换为 Assistant UI 格式 |
| `src/db/schema/agent-session.schema.ts` | Session 元数据持久化 Schema (claudeHomePath, sdkSessionId 等) |
| `src/db/schema/session-document.schema.ts` | Session 文档关联 Schema (workspace knowledge-base) |

### 架构流程

```
Frontend (Browser)
    ↓ WebSocket (/ws/agent)
ws-server.mjs (主进程)
    ├─ 认证验证 (Better Auth)
    ├─ 会话管理 (workspaceSessionId ↔ sdkSessionId 映射)
    └─ 进程管理 (spawn/kill)
        ↓
ws-query-worker.mjs (子进程)
    └─ query() from @anthropic-ai/claude-agent-sdk
        ├─ 沙盒环境 (CLAUDE_HOME, cwd)
        ├─ Skills 加载 (.claude/skills)
        └─ 结构化输出 (JSON Schema)
```

### 关键配置选项

```javascript
// ws-query-worker.mjs 中的 query() 调用
const result = await query({
  prompt: userMessage,
  cwd: sessionWorkspace,                    // Per-Session 工作目录
  settingSources: ['project'],              // 加载 .claude/skills
  tools: { preset: 'claude_code' },         // 工具集
  systemPrompt: { preset: 'default', append: customPrompt },
  outputFormat: { schema: jsonSchema },     // 可选：结构化输出
  resumeSessionId: previousSdkSessionId,    // 可选：会话恢复
});
```

### 文档获取方式

Claude Agent SDK 文档相对较新，**无法通过 MCP 工具获取**，需要：
1. 通过 Web 搜索获取最新文档
2. 查看 SDK 源码和 TypeScript 类型定义

### 环境变量

```bash
# Anthropic / ARK 网关
# ⚠️ ARK（火山）coding 网关用 Bearer 鉴权：设 ANTHROPIC_AUTH_TOKEN，**不要**设 ANTHROPIC_API_KEY
#    （设了 ws-server 会注入它，SDK 改走 x-api-key 而非 Bearer，ARK 会失败）。
#    鉴权无需改代码：worker 继承 process.env，SDK 调起的 CLI 直接读以下环境变量。
ANTHROPIC_AUTH_TOKEN=<ark-api-key>           # ARK：Bearer token（生产用这个）
ANTHROPIC_API_KEY=<your-api-key>             # 仅原生 Anthropic / x-api-key 场景
ANTHROPIC_BASE_URL=<gateway-base-url>        # ARK: https://ark.cn-beijing.volces.com/api/coding
ANTHROPIC_MODEL=<model>                       # 主模型（如 glm-5.1）
# 模型别名（按 ARK 可用模型映射；haiku=后台廉价档）
ANTHROPIC_DEFAULT_SONNET_MODEL=<model>
ANTHROPIC_DEFAULT_OPUS_MODEL=<model>
ANTHROPIC_DEFAULT_HAIKU_MODEL=<model>        # 如 doubao-seed-2.0-lite
CLAUDE_CODE_SUBAGENT_MODEL=<model>

# 模型注册表 v2（2026-07-05）：模型（对话/识图/生图/生视频/向量）、凭据、全局变量
# 全程可在 UI 管理（/admin/models、/admin/variables）——admin 粘贴的 API key 用
# AES-256-GCM 加密落库，主密钥每部署生成一次（openssl rand -hex 32）、勿随意轮换
# （轮换后 DB 已存凭据需重新粘贴）。不设则 UI 粘贴入口禁用、仅 tokenEnv(.env) 连接可用。
# ⚠️ OXY_MODELS_SEED 语义已改：仅在 model_connection 表为空时整体插入；表非空后
# DB/UI 是唯一真相源（旧「改默认要 DB+env 两处」的坑已废）。
KIN_SECRET_KEY=<openssl rand -hex 32>

# WebSocket 服务器
WS_PORT=3001
APP_URL=http://localhost:5000
CLAUDE_SESSIONS_ROOT=/data/users
# 默认关闭（强制默认）。开启会触发 SDK outputFormat 的 Stop-hook 强制机制：
# 模型未调用 StructuredOutput 时会多跑一轮，并把 “You MUST call the StructuredOutput tool”
# 内部反馈漏进对话。根因与 artifact/结构化输出策略耦合，归 Phase C/real-preview 线统一定，
# 在此之前一律保持关闭。重启命令里用 `ENABLE_STRUCTURED_OUTPUTS=false` 覆盖。
ENABLE_STRUCTURED_OUTPUTS=false  # 默认关闭，详见 docs/.../2026-06-real-preview-architect-brief.md
```

---


## TanStack Start 核心规则（来自 .ruler/AGENTS.md）

### 数据加载规则
1. **Fetch on navigation**：在 route loaders 中获取数据（SSR + streaming）
2. **Server work**：通过 TanStack Start server functions 在服务端完成
3. **URL as state**：将页面/UI 状态保持在 URL 中（typed search params）
4. **Effects for external only**：useEffect 只用于真实的外部副作用（DOM、订阅、分析）
5. **数据分层**：
   - Server-synced domain data → TanStack DB collections
   - Ephemeral UI/session → zustand 或 localStorage
   - Derived views → render 时计算或 live queries

### 服务端函数（Server Functions）最佳实践

> **官方文档**: [Server Functions | TanStack Start](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions)

Server Functions 是 TanStack Start 推荐的 **类型安全的 RPC 机制**，用于替代传统 REST API。

#### 核心优势

| 特性 | REST API | Server Functions |
|------|----------|------------------|
| **类型安全** | ❌ 手动维护类型定义 | ✅ 自动推导 |
| **调用方式** | `fetch('/api/...')` | `await fn()` |
| **序列化** | ❌ 手动 `JSON.stringify/parse` | ✅ 自动处理 |
| **错误处理** | ❌ 手动检查 `response.ok` | ✅ 自动处理 |
| **认证** | ❌ 每个路由单独检查 | ✅ 统一 `requireUser()` |
| **Redirect** | ❌ 手动处理 30x 响应 | ✅ `throw redirect()` |
| **Validation** | ❌ 需要中间件 | ✅ 内置 `inputValidator` |
| **Bundle 安全** | ⚠️ 需要手动配置 | ✅ 自动隔离 |

#### 基本用法

**定义 Server Function**：
```typescript
// src/server/function/skills.server.ts
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

// GET 请求（默认）
export const listSkillsStore = createServerFn({ method: 'GET' })
  .handler(async () => {
    return await getSkillsStore();  // 返回类型自动推导
  });

// POST 请求 + 输入验证
export const enableUserSkill = createServerFn({ method: 'POST' })
  .inputValidator(z.object({
    skillName: z.string().min(1),
  }))
  .handler(async ({ data }) => {
    const user = await requireUser();
    await enableSkill(user.id, data.skillName);
    return { success: true };
  });
```

**在路由 loader 中调用**：
```typescript
// src/routes/agents/skills/route.tsx
export const Route = createFileRoute('/agents/skills')({
  loader: async () => {
    // 并行加载数据（SSR + streaming）
    const [skills, enabledSkills] = await Promise.all([
      listSkillsStore(),
      listUserSkills(),
    ]);
    return { skills, enabledSkills };
  },
  component: () => {
    const { skills, enabledSkills } = Route.useLoaderData();
    return <SkillsPageComponent skills={skills} enabledSkills={enabledSkills} />;
  },
});
```

**在组件中调用**：
```typescript
import { useServerFn } from '@tanstack/react-start';

export const SkillsPageComponent = ({ skills, enabledSkills }) => {
  const enableSkill = useServerFn(enableUserSkill);

  const handleToggle = async (skillSlug: string) => {
    // 类型安全的调用
    await enableSkill({ data: { skillName: skillSlug } });
  };
};
```

#### 规范要求

1. **❌ 禁止使用 REST API 路由**
   - 不要创建 `/routes/api/skills/*.ts` 文件
   - 不要使用 `server: { handlers: { GET: ... } }` 模式
   - 不要在前端使用 `fetch('/api/...')`

2. **✅ 必须使用 Server Functions**
   - 所有服务端操作定义为 `createServerFn()`
   - 前端通过 `useServerFn()` 或直接调用
   - 输入验证使用 Zod schemas

3. **✅ 数据加载在 loader 中**
   - 页面初始数据在 `loader` 中预加载
   - 使用 `Promise.all()` 并行加载
   - 组件通过 `Route.useLoaderData()` 获取数据

4. **✅ 认证统一处理**
   ```typescript
   const requireUser = async () => {
     const { headers } = getRequest();
     const session = await auth.api.getSession({ headers });
     if (!session?.user) throw new Error('UNAUTHORIZED');
     return session.user;
   };
   ```

#### 重构示例

**Before（❌ 不推荐）**：
```typescript
// REST API 路由
export const Route = createFileRoute('/api/skills/store')({
  server: {
    handlers: {
      GET: async () => {
        return Response.json(await getSkillsStore());
      },
    },
  },
});

// 前端 fetch 调用
loadAvailableSkills: async () => {
  const response = await fetch('/api/skills/store');
  const data = await response.json();
  set({ availableSkills: data });
}
```

**After（✅ 推荐）**：
```typescript
// Server Function
export const listSkillsStore = createServerFn({ method: 'GET' })
  .handler(async () => {
    return await getSkillsStore();
  });

// 路由 loader
export const Route = createFileRoute('/agents/skills')({
  loader: async () => {
    const skills = await listSkillsStore();
    return { skills };
  },
});

// 组件使用 props
export const SkillsPageComponent: FC<{ skills: SkillInfo[] }> = ({ skills }) => {
  // 数据已通过 loader 加载
};
```

#### 认证和错误处理

```typescript
// Server Function 自动处理 redirect/notFound
export const requireAuth = createServerFn()
  .handler(async () => {
    const user = await getCurrentUser();
    if (!user) {
      throw redirect({ to: '/login' });  // 自动重定向
    }
    return user;
  });

// 前端调用：自动处理响应
const user = await requireAuth();  // 未认证时自动跳转
```

#### 环境变量安全

```typescript
// ❌ 危险：可能泄露到客户端
const apiKey = process.env.SECRET_KEY;

// ✅ 安全：使用 Server Function
const getApiKey = createServerOnlyFn(() => {
  return process.env.SECRET_KEY;  // 永远只在服务端
});
```

#### 参考文档

- [Server Functions 官方文档](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions)
- [Code Execution Patterns](https://tanstack.com/start/latest/docs/framework/react/guide/code-execution-patterns)
- [Static Server Functions](https://tanstack.com/start/latest/docs/framework/react/guide/static-server-functions)

### 项目约束
- ✅ 使用 pnpm
- ✅ 所有路由文件必须是 TypeScript React (`.tsx`)
- ✅ 使用 alias imports：`~` 解析为 `./src` 根目录
- ❌ **禁止**更新 `.env`（应更新 `.env.example`；本地覆盖只写 gitignored 的 `.env.local`，见「本地运行环境」）
- ❌ **禁止**使用 `pnpm run dev` / `npm run dev` 启动（`vite dev` 被 nitro-nightly bug 卡死，每页 500；本地运行改用 `scripts/local-prod.sh`，见「本地运行环境」）
- ❌ **禁止**创建本地 pnpm store

### 路由验证工具

项目提供了自动化路由验证工具，用于检查代码是否符合 TanStack Start 最佳实践。

#### 使用方法

```bash
# 运行路由验证
pnpm validate-routes

# 查看验证脚本
cat scripts/validate-routes.mjs

# 查看使用指南
cat scripts/README.md
```

#### 验证内容

**错误级别（必须修复）**：
- ❌ 禁止 REST API 路由（`server: { handlers: { GET } }`）
- ❌ 禁止在 loader 中使用 `fetch()`
- ❌ 禁止在 zustand store 中获取数据

**警告级别（建议优化）**：
- ⚠️  推荐使用 Server Functions 而不是 `fetch()`
- ⚠️  避免在 `useEffect` 中获取数据
- ⚠️  Loader 应使用 `Promise.all()` 并行加载数据

#### 集成到开发流程

**提交前检查**：
```bash
# 1. 验证路由
pnpm validate-routes

# 2. 运行 linter
pnpm lint

# 3. 运行测试
pnpm test
```

**当前项目状态**：
- 总文件数：48 个路由文件
- 通过验证：21 个
- 需要优化：29 个（主要是旧的 REST API 路由）

**参考文档**：
- [验证工具使用指南](scripts/README.md)
- [手动检查清单](docs/ROUTE_VALIDATION_CHECKLIST.md)

### Hydration + Suspense 规则
- 同步更新导致 suspend → fallback 替换 SSR 内容
- 解决：用 `startTransition` 包装同步更新（直接 import）
- hydration 期间避免：`useTransition` 的 `isPending`、`useSyncExternalStore` mutation

### 嵌套路由规则（重要！）

> **官方文档参考**: https://tanstack.com/router/latest/docs/framework/react/routing/file-based-routing

TanStack Router 使用文件系统来表示路由层级。当子目录包含 `route.tsx` 时，会形成嵌套路由关系。

**官方定义**（摘自 TanStack Router 文档）：
- **Layout Routes**: 用于包装子路由的组件和逻辑，内部使用 `<Outlet />` 作为嵌套内容的占位符
- **`route.tsx`**: 在目录中定义该路径的组件（如 `/account` 对应 `account/route.tsx`）
- **`index.tsx`**: 当路由精确匹配且没有子路由匹配时激活
- **`<Outlet />`**: 渲染下一个可能匹配的子路由，不接受任何 props，可放置在路由组件树的任何位置

**核心规则**：
1. 父路由（Layout Route）必须提供 `<Outlet />` 组件来渲染子路由内容
2. 如果路由没有定义组件，会自动渲染 `<Outlet />`
3. 如果没有子路由匹配，`<Outlet />` 返回 `null`

**目录结构示例**：
```
routes/
├── parent/
│   ├── route.tsx      ← Layout Route（包装子路由，需要 Outlet）
│   ├── index.tsx      ← /parent 的默认内容
│   └── child/
│       └── route.tsx  ← /parent/child 的内容
```

**常见错误**：
❌ 错误：`parent/route.tsx` 不包含 `<Outlet />`，导致访问 `/parent/child` 时子路由无法显示
✅ 正确：父路由使用 `<Outlet />` 或条件渲染

**条件渲染模式**（当父路由既有自己的内容，又需要渲染子路由时）：
```typescript
import { Outlet, useMatch } from '@tanstack/react-router';

function RouteComponent() {
  const childMatch = useMatch({
    from: '/parent/child',
    shouldThrow: false,
  });

  if (childMatch) {
    return <Outlet />;  // 渲染子路由
  }

  return <ParentContent />;  // 渲染父路由自己的内容
}
```

**替代方案**（更符合官方推荐的 Layout 模式）：
```typescript
// parent/route.tsx - 作为纯 Layout
function ParentLayout() {
  return (
    <div className="parent-wrapper">
      <Outlet />  {/* 子路由或 index 内容在此渲染 */}
    </div>
  );
}

// parent/index.tsx - 父路由的默认内容
function ParentIndex() {
  return <ParentContent />;
}
```

---

## Docker 修改规则（强制执行）

### 核心文件修改前的强制检查

**在对 Dockerfile、docker-compose.yml、启动脚本等核心文件做任何修改前，必须：**

#### 1. 对比原始脚手架
```bash
# 在参考目录验证原始行为（若本地有原始脚手架）
cd <path-to-original-starter>
pnpm run build
# 检查输出结构
ls -la .output/
```

#### 2. 确认问题根源
- 问题是否是本地修改导致的？
- 原始脚手架是否有同样问题？
- 如果原始版本正常，找出差异在哪里

#### 3. 最小修改原则
- 优先修复配置，而不是添加新文件
- 优先调整参数，而不是重写逻辑
- 优先复用现有能力（Nitro、Vite），而不是自己实现

#### 4. 禁止的操作
- ❌ 在没对比原始版本前修改 Dockerfile
- ❌ 在没验证 index.mjs 能力前创建包装脚本
- ❌ 在没检查 Nitro 文档前自己实现功能

### 框架能力优先
TanStack Start + Nitro 已提供的能力，**不要重新实现**：
- ✅ 静态资源服务（Nitro 自动处理 `/assets/**`）
- ✅ SSR 渲染
- ✅ 路由处理
- ✅ 中间件

### 具体案例的"正确路径"

**错误路径示例**（实际发生过的）：
```
看到 .output 不存在 → 修改 Dockerfile 复制 dist → 创建 run-server.mjs → ...
```

**正确路径**：
```
1. 对比原始脚手架（若本地有原始脚手架）
   cd <path-to-original-starter>
   pnpm run build
   ls -la .output/  # 发现存在

2. 检查当前版本为什么不同
   git diff vite.config.ts  # 检查配置差异
   pnpm list @tanstack/react-start  # 检查版本

3. 如果版本一致，检查是否是缓存问题
   rm -rf .output dist
   pnpm run build

4. 只有确认原始脚手架也有同样问题时，才考虑修改 Dockerfile
```

### 新文件的门槛
创建新的核心文件（如启动脚本、包装器）前必须证明：
- 现有方案无法解决
- 没有框架内置功能可用
- 已查阅相关文档
- 已在原始脚手架验证

---

## Dokploy 部署规则

> ⚠️ **定位（2026-06-12 Owner 确认）**：Dokploy 是**未启用的备选方案**——oxygenie.cc
> **并未**使用 Dokploy 部署（实际方式见下文「生产部署（oxygenie.cc）」节）。本节与
> `docs/deployment/dokploy.md` 仅作历史资料/未来备选参考，**不要**按本节流程"更新生产"。

### Docker 镜像构建与推送

项目使用 **GHCR (GitHub Container Registry)** 存储 Docker 镜像，Dokploy 从 GHCR 拉取镜像部署。

#### 构建方式优先级

1. **GitHub Actions（推荐）**：推送到 `main` 分支时自动构建
2. **本地构建（备选）**：当 GitHub Actions 不可用时使用

#### 本地构建命令（重要！）

**⚠️ 架构要求**：Dokploy 服务器运行在 **AMD64 (x86_64)** 架构，本地 Mac (Apple Silicon) 是 **ARM64**。

```bash
# ✅ 正确：指定目标平台为 linux/amd64
docker buildx build --platform linux/amd64 \
  -t ghcr.io/deeptoai-com/kin/app:latest \
  --push .

# ❌ 错误：不指定平台（会构建本机架构 arm64）
docker build -t ghcr.io/deeptoai-com/kin/app:latest .
docker push ghcr.io/deeptoai-com/kin/app:latest
```

#### 推送前认证

```bash
# 确保有 write:packages 权限
gh auth refresh -h github.com -s write:packages

# 登录 GHCR
echo $(gh auth token) | docker login ghcr.io -u USERNAME --password-stdin
```

#### 验证镜像架构

```bash
# 拉取并检查架构
docker pull ghcr.io/deeptoai-com/kin/app:latest
docker inspect ghcr.io/deeptoai-com/kin/app:latest | jq '.[0].Architecture'
# 应输出: "amd64"
```

### Dokploy 镜像拉取策略

**问题背景**：Docker Compose 默认 `pull_policy: missing`，只在镜像不存在时拉取。导致更新镜像后 Dokploy 仍使用旧的本地缓存。

**解决方案**：在 `docker-compose.dokploy.yml` 中为所有使用应用镜像的服务添加：

```yaml
services:
  app:
    image: *app_image
    pull_policy: always  # 强制每次拉取最新镜像

  migrate:
    image: *app_image
    pull_policy: always

  worker:
    image: *app_image
    pull_policy: always
```

**注意**：多个服务使用同一镜像时，Docker 只会拉取一次，后续服务复用已拉取的镜像。

### 部署检查清单

1. ✅ 确认代码已推送到 GitHub
2. ✅ 确认镜像架构为 `linux/amd64`
3. ✅ 确认 `docker-compose.dokploy.yml` 包含 `pull_policy: always`
4. ✅ 在 Dokploy 触发重新部署
5. ✅ 检查部署日志确认拉取了新镜像（看 digest 是否变化）

### 生产部署（oxygenie.cc）—— 本地部署 + Cloudflare 隧道（2026-06-12 Owner 确认）

**oxygenie.cc 没有使用 Dokploy。** 它跑在 owner 本地机器的 docker stack 上
（`docker-compose.tunnel.yml`，镜像 `oxygenie:local` **本地构建**、`pull_policy: never`），
经 Cloudflare 隧道（cloudflared）穿透对外，成为事实上的生产环境。

**更新 oxygenie.cc（= 更新本地 stack；不走 amd64/GHCR/Dokploy）：**

> ⚠️ **M0（多架构镜像 + D1 生产收敛）合并后此流程变化**：`docker-compose.tunnel.yml` 默认已改为
> 从 `ghcr.io/deeptoai-com/kin/{app,parser}` **拉取**（`pull_policy` 默认 `always`）。要继续**本地构建**
> （不拉 GHCR），必须显式 `APP_PULL_POLICY=never` 并叠加 `-f docker-compose.build.yml`（让 app+parser
> 走本地 `build:`）。GHCR 镜像发布且设为 public 后，推荐直接 `docker compose pull` + `up -d`。下方旧命令
> 仅在加了上述两项后仍有效。

```bash
git pull
# tag 按用途取：kin:local（常规）或 kin:<feature>-test（灰度）；下面 APP_TAG 必须与之一致。
DOCKER_BUILDKIT=1 docker build --build-arg BUILD_SHA=$(git rev-parse HEAD) -t kin:local .   # 本机 arm64 即可；用完整 sha（非 --short），与 CI 烤的一致，updater/健康检查按值精确比较
# ⚠️ 改名(Kin)后必须 source **prod-merged.env**（全量），绝不要 source secrets.env——后者
#    APP_NAME=oxygenie / APP_NAME_SANITIZED=oxygenie-cc2 是改名前残值，一 source 就把 app/worker
#    重建到 oxygenie-cc2-private 网络、脱离 kin-private（Kin-redis/Kin-db 所在）→ ENOTFOUND redis = 全站宕机。
#    prod-merged.env 里 APP_NAME 出现两次（oxygenie 在前、Kin 在后 last-win）+ APP_PULL_POLICY=always，故下面 inline 全覆盖。
set -a; . ~/oxygenie-deploy/prod-merged.env; set +a
APP_NAME=Kin APP_NAME_SANITIZED=kin APP_IMAGE=kin APP_TAG=local APP_PULL_POLICY=never \
  docker compose -p kin -f docker-compose.tunnel.yml up -d --no-deps --force-recreate app worker
# 验证：docker inspect Kin-app …Networks 含 kin-private；docker logs Kin-app 无 ENOTFOUND/28P01；curl -sI https://oxygenie.cc → 200
```

历史资料：2026-06-05 曾按 Dokploy/GHCR 流程完成过部署验证——操作指南
`docs/deployment/dokploy.md`、决策记录 `docs/project/research/2026-06-oxygenie-cc-dokploy-deployment.md`
仅作未来备选参考。

**关键不变量(原为 Dokploy 部署总结；其中 4/5/6/9/10/11 同样适用于当前隧道栈,踩错 → 部署失败):**

1. **镜像 off-server 构建 → 推 GHCR → Dokploy 只拉取**。SSR 打包峰值大,在 Dokploy 主机和
   标准 7G CI runner 上易 OOM。`docker-compose.dokploy.yml` 用 `image:`+`pull_policy: always`(**非 `build:`**)。
   (playwright/libreoffice 已于 2026-06 **彻底移除**,镜像默认精简,无需再传 `--build-arg INSTALL_*`。)
2. **`APP_NAME_SANITIZED` 每个部署必须唯一**。卷名 `${APP_NAME_SANITIZED}-data` 是**全局名**,撞了会复用
   别的栈的数据卷(连带其旧密码)→ migrate 28P01。
3. **`DATABASE_URL` 在 compose 内从 `POSTGRES_*` 拼**(单一来源),不要独立传 `DATABASE_URL`(会与
   `POSTGRES_PASSWORD` 失配 → 28P01)。
4. **ARK 用 `ANTHROPIC_AUTH_TOKEN`(Bearer),不设 `ANTHROPIC_API_KEY`**(见上「环境变量」段)。
5. **域名**:app=apex;预览=**单层 `*.oxygenie.cc`**(CF 免费 SSL 不覆盖两层 `*.preview.*`)。
6. **TLS**:CF 橙云 + **Full(Strict) + Origin CA 证书**,**不用 Let's Encrypt**(橙云下 HTTP-01 失败);
   compose 路由用 `tls=true`(默认 Origin 证书),不用 `certresolver=letsencrypt`。
7. **migrate 会重试直到 `db` 可解析**(Dokploy 上 `db` 别名有 DNS 时序,`depends_on:healthy` 挡不住 `EAI_AGAIN`)。
8. **GHCR 包设 public**(或给 Dokploy 加 registry 凭据),否则拉不到。
9. `VITE_WS_URL` **无需**烤进镜像 —— 前端运行期按 `wss://<当前域名>/ws/agent` 自算(`ws-adapter.ts`)。
10. **preview-controller** 已硬化(`CapAdd:['CHOWN']` + detached serve + 自写容器内 pid)。
11. **预览鉴权路由必须用 Traefik v3 正则语法**。`preview-auth` 路由的 `HostRegexp` 用 v3 Go 正则
    `HostRegexp(`^[a-z0-9-]+\.${APP_HOSTNAME}$`)`,**不可**用 v2 命名组 `HostRegexp(`{name:regexp}`)`——
    Dokploy/隧道都是 **traefik v3**,v2 语法**静默永不匹配**,导致 `<id>.域名/__oxy/preview/auth?t=…`
    直接 404、预览打不开(此前被误判为 Dokploy-Swarm 路由问题)。compose 里写 `\\.`(YAML→`\.`)、
    `$$`(compose 插值→`$` 末尾锚)。已修于 `docker-compose.{tunnel,dokploy}.yml`。

> **瘦身进行中**:**Mastra 已移除（2026-06）**；仍待砍 **playwright + libreoffice**，之后确认 SSR
> 构建可在 7G runner 内完成 → 恢复 `build.yml` push-main 自动构建 GHCR(开源贡献者就不必本地 16G 构建)。
