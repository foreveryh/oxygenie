# PRD：A2Composer —— 对话内「技能快捷入口」（重做）

> 日期：2026-06-07 ｜ 状态：草案待 owner 评审
> 关联：
> - `prd/2026-06-skills-integration-prd.md`（Skills 三层模型、D6 默认只启用 2 个、**D7 手动加载＝聊天窗快捷入口**、D9 baoyu 模板暂失效待重做）—— 本 PRD 即 D7 那个「快捷入口」的正式设计。
> - `research/2026-06-skills-existing-architecture-and-redesign.md`（启用＝物化 SKILL.md 到 FS、本地生成变量 schema）。
> - `VISION.md`（自托管 / 单组织 / 半可信同事威胁模型 / 精选非市场）。
> - 数据源：`src/db/seed/curated-skills.json`（精选 100，含 category/level/firstTaskZh/suitableForZh/problemZh/iconEmoji/riskNotesZh）。

---

## 0. 决议与关键约束（2026-06-07）

**Owner 已拍板：**
- **保留 + 重做（派生自技能目录）**（K1+K2）。
- 分类**收成 5 个面向任务的大类**（映射自技能 `category`，给中文展示名）（K3 取「大类」方案）。

**面向任务的 5 大类 ↔ 技能 `category` 映射：**

| 任务大类（展示） | 映射自 `category` | 约数 |
|---|---|---|
| 写作与内容 | writing | 18 |
| 设计与前端 | design_frontend | 21 |
| 自动化与集成 | automation + security | 19 |
| 研究与策略 | research + learning | 22 |
| AI 工程 | ai_engineering | 20 |

> 映射只是**展示层**（`category → bucket` 的常量表），不改技能底层 `category` 字段；目录仍是单一真相。

**关键技术约束（来自 STATUS.md · Skills S2，已 owner 测试）：**
> 启用技能＝物化 SKILL.md 到 `~/.claude/skills/<slug>/`，但 **SDK 0.2.112 无法热加载正在运行的会话；新启用的技能「下次对话生效」**。

**对本功能的硬影响（必须设计进去）：**
- **当场用不了未启用的技能。** 选中一个**未启用**技能：可一键启用+物化，但要等**新对话**才被 SDK 加载。
- 因此把技能分两态呈现：
  - **已启用（本会话可用）** → 选中＝直接填 `firstTaskZh` 起手，立即可发。
  - **未启用** → 选中＝启用+物化 + 填起手 prompt + **明确提示「已加入，新对话生效」**，并提供「**开启新对话并加载**」一键动作。
- 这也精确回答了原始疑问：**要在当前对话里真正跑某技能，它必须已启用（上次启用、本会话起始已物化）**；快捷入口的「按需启用」是为**下一次对话**准备，不是当场注入。

---

## 1. 现状（代码核对，2026-06-07）

- **是什么**：聊天 composer 上方的分类下拉胶囊（内容创作 / 内容整理 / 设计与呈现 / 策略与研究），每类挂若干「模板」，选中后把一段起始 prompt 填进输入框。
- **数据**：`src/lib/a2composer/config.ts` 手写 **4 个分类 + 8 个模板**；持久化为 `templates.json`（admin 可在 `/admin/a2composer` 编辑）。
- **绑定技能的代码**：`a2composer-panel.tsx` `handleSelectTemplate` —— 仅当 `template.skillId` 存在时才 `ensureSkillEnabled(skillId)`（按需启用）+ `addTemporarySkill`。
- **关键缺陷**：
  - **F1 未接线**：8 个模板 **`skillId` 全为空**，只有 `skillHint`（装饰用，仅渲染一个 badge，从不解析）→ **选中模板今天只填 prompt，不启用/不加载任何技能**。
  - **F2 分类对不上**：手写的 4 个分类与精选技能自带的 7 个 `category` 完全不一致。
  - **F3 双重维护 + 漂移**：模板的 title/summary/prompt/图标都在手写，与技能自身的 `titleZh/summaryZh/firstTaskZh/iconEmoji` 重复且已漂移；其中 2 个 `skillHint`（`baoyu-danger-x-to-markdown`、`design-md`）在 store 里根本不存在（D9 删除 baoyu 本地资产的已知后果）。
  - **F4 违反 DS**：4 个分类图标是 emoji（✍️🧩🎨🧠），违反新设计系统「无 emoji」。

> 一句话：这个功能是 skills 架构 **D7「手动加载」** 的落地面，但当前是一套**与技能脱钩、手工维护、已漂移、且未接线**的平行模板库。

---

## 2. 该不该存在？—— 该，但要换底座

**该存在。** 理由直接来自既定的 skills 架构：

- **D6 决定默认只启用 2 个技能**（`find-skills` + `skill-creator`），其余 98 个**不预加载**（否则每次对话都把上百份 SKILL.md 塞进上下文，污染且烧 token）。
- 既然不预加载，就**必须有一个「在对话里按需把某个技能拉进来」的入口** —— 这正是 D7，也正是 A2Composer 的位置。
- 没有它，用户要用第 3~100 个技能只能去 Skills 页逐个手动启用，**断了「边聊边用」的心流**，精选 100 的价值大打折扣。

**它解决的真实问题（JTBD）：**
1. **冷启动 / 空白页**：「今天我能帮你什么？」对着空输入框无从下手 → 给到「这类活儿可以这样开头」。
2. **发现**：100 个技能太多、记不住 → 按「我现在要干的活」分类浮现相关技能。
3. **按需加载（上下文卫生）**：选中即把**那一个**技能物化进当前会话（D7），而非全量加载。
4. **零安装门槛**：不要求用户事先在 Skills 页启用 —— 选中即 `ensureSkillEnabled` 当场启用（**不依赖已安装**，回答了核对中的疑问）。
5. **引导式输入**：技能有 `.schema.json` 时，渲染可填充变量表单，降低 prompt 工程门槛。

> 注意「硬加载 skill.md」的边界：入口**只能拉精选 store 里存在的技能**（`enableSkill` 作用于已知 slug，启用＝把该技能的 SKILL.md 物化到 `~/.claude/skills/<slug>/` 让 SDK 读）。**不会**注入任意外部 skill.md —— 与 VISION「精选非公开市场」一致。

**给谁：**
- **主要**：组织内会用聊天、但不熟悉「有哪些技能 / 该启用哪个」的成员（半可信同事）—— 让他们不查文档也能用对技能。
- **次要**：熟练用户的加速器（少点几下就把对的技能 + 起手 prompt 一并就位）。

---

## 3. 核心洞察：派生自技能，而非平行模板库

精选技能**已经**带齐了快捷入口所需的一切，无需另写模板：

| 快捷入口需要 | 直接取自技能字段 |
|---|---|
| 分类分组 | `category`（design_frontend / ai_engineering / automation / writing / research / learning / security） |
| 胶囊/卡片标题 | `titleZh` / `name` |
| 一句话说明 | `summaryZh` |
| **起手 prompt** | `firstTaskZh`（天然的 starter） |
| 适合谁 | `suitableForZh` |
| 图标 | `iconEmoji`（DS 场景改用 lucide 线性图标） |
| 风险提示 | `riskNotesZh`（启用前护栏文案） |
| 排序 | `sortWeight` / `level` |
| 绑定的技能 | **就是这条技能自己**（slug，天然 `skillId`） |

**结论**：A2Composer 从「手写 4 分类 + 8 模板（漂移、未接线）」改为「**精选技能的一个对话内视图**」：按 `category` 分组，卡片＝技能，起手＝`firstTaskZh`，选中＝`ensureSkillEnabled(slug)` + 物化 + 把 `firstTaskZh` 填入 composer（+ 有 schema 则展开变量表单）。**单一真相＝技能目录，零重复维护。**

> 模板能力不丢：`A2Template` 降级为**可选的覆盖层**（admin 想给某技能定制更细的多步模板/变量时才写；默认不需要），`templates.json` 从「必需的平行库」变为「可选 override」。

---

## 4. 目标 / 非目标

**目标**
- G1 快捷入口**派生自精选技能目录**（DB 为真相），按技能 `category` 分组，卡片用技能自带元数据；**删除手写的 4 分类与漂移模板**。
- G2 选中即**按需启用 + 物化**该技能进当前会话（D7），**不依赖事先启用**；起手 prompt＝`firstTaskZh`。
- G3 有 `.schema.json` 时渲染**可填充变量表单**；无则只填起手 prompt（优雅降级）。
- G4 **风险感知**：`riskNotesZh` 非空（如触达 Shell / 内网 / 浏览器）时，启用前给一句轻量提示（warn-not-ban，符合威胁模型）。
- G5 **符合 DS**：emoji → lucide 线性图标 + 信号绿；胶囊改 hairline/mono 编辑风。
- G6 与 Skills 页（能力中心）**分工清晰**：能力中心＝浏览/搜索/治理/持久启用；A2Composer＝对话内即时发现 + 按需加载 + 起手。

**非目标（本期）**
- 不做公开市场 / 评分 / 付费 / 技能包 bundle（VISION）。
- 不在快捷入口里直接「从上游 9600 搜索添加」（那是 Skills 页 G5 的事；这里只面向**已精选**的目录）。
- 不做团队级共享模板（org 级留 backlog）。
- 不保留手写平行模板库为「必需」（降级为可选 override）。

---

## 5. 关键决策（待 owner 拍板）

| # | 决策 | 倾向 / 依据 |
|---|------|------|
| K1 | **保留功能**（不删） | 它是 skills D7 的落地面，删了「按需加载」断链 |
| K2 | **底座换成「派生自技能目录」**，删手写 4 分类 + 漂移模板 | §3；消除 F1/F2/F3 |
| K3 | 分组用技能自带 `category`（7 类，可中文化重命名） | 与目录单一真相一致 |
| K4 | 起手 prompt＝`firstTaskZh`；变量表单＝本地 schema（有则展开） | 零重复维护 + 既有 generator |
| K5 | 选中＝`ensureSkillEnabled(slug)`（按需启用，不依赖预启用）+ 物化进当前会话 | D7 |
| K6 | `A2Template` 降级为**可选 override**（admin 想定制才写） | 不丢能力、不强制维护 |
| K7 | 启用高风险技能（`riskNotesZh` 非空）前给轻量提示 | 威胁模型「warn-not-ban」 |
| K8 | emoji → lucide 线性图标，胶囊改 DS 编辑风 | 设计系统 |
| K9 | 入口可被关闭（admin 开关 / feature flag），默认开 | 可控落地 |

---

## 6. 重新设计的交互模型

1. **入口**：composer 上方的分类胶囊 = **5 个任务大类**（lucide 图标，映射自技能 `category`）。只展示有 ≥1 个技能的大类。
2. **展开大类** → 该大类下的技能卡片（`titleZh` + `summaryZh` + `suitableForZh`，按 `sortWeight`/`level`）；每张卡标注**状态徽标**：`已启用·本会话可用` / `未启用·新对话生效`。
3. **选中一个技能** —— 按状态分流（受 SDK「下次对话生效」约束，见 §0）：
   - **已启用** → 直接把 `firstTaskZh`（或该技能 override 模板）填入 composer；有 `.schema.json` 则展开变量表单（沿用 `getSkillSchema` + `applyTemplate`）→ **可立即发送**。
   - **未启用** → 若 `riskNotesZh` 非空先弹一行护栏（继续/取消）→ `ensureSkillEnabled(slug)` 启用+物化 → 填起手 prompt → 明确提示 **「已加入，新对话生效」**，并给「**开启新对话并加载**」一键动作。
4. **发送**：照常走 ws → SDK；**已物化**的技能由 `settingSources:['project']` 在会话起始加载（当前会话只对「会话开始前已物化」的技能生效）。
5. **会话结束**：临时加载的技能按既有 `disableUserSkills`/session 清理回收（保持默认集精简）。

**降级**：技能无 `firstTaskZh` → 用 `summaryZh` 兜底；无 schema → 仅填 prompt；分类无技能 → 不显示该胶囊。全程不报错。

---

## 7. 与 Skills 能力中心的分工

| 维度 | Skills 页（能力中心） | A2Composer（对话内快捷入口） |
|---|---|---|
| 场景 | 事前浏览 / 搜索 / 治理 | 对话中即时、按当前任务 |
| 操作 | 持久启用/停用、看详情、从上游添加 | 按需把**一个**技能拉进**当前会话** + 起手 |
| 真相 | 同一 DB 目录 | **同一 DB 目录的对话内视图** |
| 心智 | 「我管理我的技能箱」 | 「我现在要干这活，给我对的技能 + 开头」 |

二者共享同一目录与启用机制，A2Composer 不再有独立数据。

---

## 8. 实施分期

- **P0｜接线 + 派生（最小可用）**：分类来自技能 `category`；卡片来自技能元数据；选中＝`ensureSkillEnabled(slug)` + 填 `firstTaskZh`。删 `config.ts` 手写分类/模板对 UI 的依赖（`A2_TEMPLATES` 退为可选 override）。修 F1/F2/F3。
- **P1｜引导输入 + 风险护栏**：有 schema 展开变量表单；`riskNotesZh` 启用前提示（K7）。
- **P2｜DS 视觉**：emoji→lucide、胶囊编辑风（K8），与首页/composer 一致。
- **P3｜admin override + 开关**：`/admin/a2composer` 改为「给某技能写可选 override 模板」；feature flag（K9）。状态注记（2026-07-08）：P3 尚未实施，当前 admin 入口已从导航移除；直达页仅保留未来 override 的提示与存量编辑能力。
- **P4（backlog）**：按 `recommendationTags`/`level` 二级筛选、最近使用、按当前对话上下文智能推荐技能。

> 依赖：P0 依赖 skills 执行层（启用→物化、目录 DB 为真相）已就绪到「能 `ensureSkillEnabled` 任意精选 slug」。需先确认该前置（skills-integration PRD 的 S2 执行层状态）。

---

## 9. 成功标准 / 度量

- 选中快捷入口后，目标技能**确实被启用并在该次对话生效**（可观测：会话 metadata 出现该 slug）。
- 「填了 prompt 但没加载技能」的现象归零（F1 闭环）。
- 分类与精选目录 100% 一致，无漂移、无指向不存在 slug 的死链（F2/F3 闭环）。
- 视觉无 emoji、符合 DS（F4 闭环）。
- （软指标）新成员不看文档即可经快捷入口用上正确技能。

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 按需启用了触达宿主的高风险技能 | K7 启用前 `riskNotesZh` 提示；沙盒护栏（既有） |
| 7 个英文 category 直接示人偏技术 | 给中文展示名映射（design_frontend→「前端 / 设计」等），不改底层值 |
| 100 技能铺开太满 | 每类默认折叠 + 取 topN（`sortWeight`），「更多」进 Skills 页 |
| 执行层「任意 slug 按需物化」未完全就绪 | P0 前先核对 skills S2 状态；未就绪则先做派生 UI + 优雅降级 |

---

## 11. 待 owner 确认

**已定（2026-06-07）：**
- ✅ K1/K2 方向：保留 + 派生自技能重做。
- ✅ K3 分类：收成 5 个面向任务大类（映射见 §0）。
- ✅ P0 前置就绪：skills 执行层 S2 已 owner 测试（STATUS 2026-06-04：启用→物化任意精选 slug，**下次对话生效**）。

**已定（续，2026-06-07）：**
- ✅ 未启用技能选中 → **启用+物化 + 填起手 prompt + 「开启新对话并加载」一键**。
- ✅ 快捷入口**全展示**技能，**未启用默认折叠**（已启用置顶可立即用）。
- ✅（默认，owner 未异议即采用）K7 高风险技能（`riskNotesZh` 非空）启用前**轻量一行提示**（非强制二次确认）。
- ✅（默认）K6 模板 override 层 → **backlog**，本期纯派生。

> 至此设计决策全部收敛，进入实施（见 §8 分期；P0 先行）。
