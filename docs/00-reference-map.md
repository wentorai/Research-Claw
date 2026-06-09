---
doc: 00-reference-map.md
audience: 全体 — RC 文档体系导航入口
status: 现行 · 2026-06-09 随两层重构重写(engineering/ + self/ 结构)
source-of-truth: 本文是**导航地图**,不复制任何易变清单(表/工具/方法数);具体数字一律去代码或对应模块文档数
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 14
---

# RC 文档体系导航(00)

> Research-Claw 文档分**两层**:`engineering/`(面向开发者,讲怎么实现、为什么这样设计)+ `self/`(RC 自述的 canonical 镜像;**运行时自我认知权威是已加载的 SOUL/IDENTITY**,非 `skill_search`)。本文是入口地图。
>
> ⚠️ 本文**不写任何计数**(表数/工具数/方法数会随版本漂移)——要数字去代码,或去对应模块文档的"易变事实权威源"表。

## 1. 结构总览

```
research-claw/docs/
├── 00-reference-map.md          ← 本文(导航)
├── engineering/                 ← 渠道 B:开发者按需阅读,不注入运行时
│   ├── architecture.md          系统架构、L0–L3 耦合层、SQLite pragma、安全模型
│   ├── interaction-design.md    Dashboard 交互哲学(Chat is the OS)、布局、刻意排除项
│   ├── prompt-architecture.md   Bootstrap 八件提示词系统、session-aware 过滤、AGENTS v4.1
│   ├── plugin-integration.md    research-claw-core 单插件聚合、装载、注册、hook
│   ├── install-startup.md       安装/启动 RC 特有设计(步骤链到根 SOP)
│   ├── qa-test-spec.md          功能清单与 QA 测试用例
│   ├── skill-workshop.md        RC 内 skill 开发
│   ├── modules/                 各业务模块
│   │   ├── literature.md        文献库
│   │   ├── tasks.md             任务系统
│   │   ├── workspace.md         工作区与 git 追踪
│   │   ├── cards.md             消息卡片协议
│   │   ├── dashboard-ui.md      Dashboard 前端工程
│   │   └── memory.md            记忆系统(后端完整 / 面板未接入)
│   └── design-backlog/          未实现/部分实现的设计储备
│       ├── knowledge-graph.md   ⛔ 未实现
│       └── memory-dashboard-ui.md 🟡 部分实现
└── self/                        ← RC 自述 canonical 镜像(identity/capabilities/behaviors)
```

## 2. "我想做 X → 读哪篇"

| 我想… | 去读 |
|-------|------|
| 理解整体架构 / 耦合层 / 安全模型 | [engineering/architecture.md](engineering/architecture.md) |
| 设计/改 Dashboard 交互 | [engineering/interaction-design.md](engineering/interaction-design.md) + [modules/dashboard-ui.md](engineering/modules/dashboard-ui.md) |
| 写/改 bootstrap 提示词(AGENTS 等) | [engineering/prompt-architecture.md](engineering/prompt-architecture.md) |
| 给 core 插件加模块 / 加 RPC / 加 hook | [engineering/plugin-integration.md](engineering/plugin-integration.md) + 对应 `modules/` |
| 做文献功能 | [modules/literature.md](engineering/modules/literature.md) |
| 做任务功能 | [modules/tasks.md](engineering/modules/tasks.md) |
| 做工作区/版本功能 | [modules/workspace.md](engineering/modules/workspace.md) |
| 加消息卡片类型 | [modules/cards.md](engineering/modules/cards.md) |
| 接通记忆面板 | [modules/memory.md](engineering/modules/memory.md) + [design-backlog/memory-dashboard-ui.md](engineering/design-backlog/memory-dashboard-ui.md) |
| 搭开发环境 / 安装调试 | [engineering/install-startup.md](engineering/install-startup.md) → 根 `docs/sop/INSTALL_SOP.md` |
| 跑功能 QA / 写测试用例 | [engineering/qa-test-spec.md](engineering/qa-test-spec.md) |
| 了解 RC 自身是什么/能做什么 | `self/`(构建中) |

## 3. 术语表

| 术语 | 定义 |
|------|------|
| **Satellite(卫星)** | 架构模式:OpenClaw 作 npm 依赖 + config overlay + 极小 patch,而非 fork |
| **Bootstrap File** | 会话启动注入 agent 上下文的 Markdown(SOUL/AGENTS 等) |
| **Coupling Tier(耦合层)** | 依赖深度 L0(文件系统)→ L1(Plugin SDK)→ L2(WS RPC)→ L3(pnpm patch) |
| **Human-in-Loop(HiL)** | 不可逆动作前 agent 必须请求人工确认 |
| **Gateway** | OpenClaw 本地服务,在 28789 端口提供 WS RPC 与 HTTP(只绑 loopback) |
| **Message Card** | 围栏代码块里的结构化数据,dashboard 渲染成富 UI 组件 |
| **Session(会话)** | dashboard 的会话单位;"项目"为未来 project-scoping 预留,当前 UI 不用 |
| **FTS5** | SQLite 全文检索扩展,文献/记忆检索用 |
| **pnpm Patch** | branding 用的 ~20 行/7 文件补丁(CLI 名、进程名等) |
| **HashMind** | 设计语言:Dark Cyberpunk Terminal;Lobster Red `#EF4444` + Academic Blue `#3B82F6` |

## 4. 关键设计决策(各文档须遵守)

| 决策 | 取值 |
|------|------|
| 任务展示 | deadline 排序列表,**不是** Kanban |
| 全局搜索 | **无** Cmd+K——agent 即搜索引擎 |
| 状态栏 | 只显 token 上下文,**不显**花费 |
| CRUD 路由 | 简单 → 直接 RPC;复杂 → 走 chat |
| Dashboard 框架 | React 18 + Ant Design 5(**不用** Lit) |
| 文献归属 | agent 自有 SQLite 库,Zotero 仅只读导入 |
| 主题 | dark 默认(终端)+ light(暖纸) |
| 安全 | 本地 loopback + 工作区沙箱 + exec guard + git 版本化 + 提示词 HiL |

> 完整安全模型见 [engineering/architecture.md](engineering/architecture.md) §8;耦合层见同文 §3。

## 5. 易变事实统一去处

| 想知道 | 去哪 |
|--------|------|
| 表/字段/SCHEMA_VERSION | `extensions/research-claw-core/src/db/schema.ts` |
| 工具清单/签名 | 各模块 `src/*/tools.ts` |
| `rc.*` 方法清单 | 各模块 `src/*/rpc.ts` |
| hook 挂载点/优先级 | `extensions/research-claw-core/index.ts` |
| 提示词字符预算 | `pnpm health` 的 budget 报告 |
| OC 兼容版本 | `openclaw.plugin.json` + 根 `package.json` |

---

*两层结构 2026-06-09 重构。本文只导航,不留计数——计数即债。*
