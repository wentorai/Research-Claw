---
doc: engineering/architecture.md
audience: 开发者 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-06-09 依代码重建
source-of-truth: 代码优先。本文以"为什么这样设计(why)"为主;"是什么/怎么做(what/how)"一律指向代码路径,易变数字不写死(见 §9)
baseline: OpenClaw 2026.6.1(pinned) · DB SCHEMA_VERSION 14
---

# Research-Claw 工程架构

> 本文是 RC 的工程总览,写给要改 RC 代码的人。它回答"系统由哪几块组成、为什么这样分层、约束在哪里",不复述代码里已经写清楚的清单。任何与代码冲突之处,**以代码为准**,并请回头修订本文。

## 1. 定位与边界

- **读者**:RC/dashboard/插件的开发者。
- **渠道**:仓库内按需阅读(渠道 B)。本文**不会**被注入 agent 运行时——运行时行为由 `workspace/.ResearchClaw/` 的提示词与 skills 决定,与本文是两条独立通道。
- **不写什么**:不抄注册方法清单、表结构 DDL、工具签名——这些代码里有且会变;本文只保留代码里看不出来的设计意图与约束。

## 2. 系统组成

RC = **OpenClaw 基座** + **dashboard 前端** + **core 插件(服务层 + 数据层后端)** + **research-plugins 技能包**。四者通过明确的接口解耦:

```
┌──────────────────────────────────────────────┐
│  dashboard (Vite + React18 + Zustand)          │  渠道 L2
│  浏览器 SPA,只经 WS RPC v3 与基座通信          │
└───────────────┬────────────────────────────────┘
                │  ws://127.0.0.1:28789  (loopback)
┌───────────────▼────────────────────────────────┐
│  OpenClaw 基座 (2026.6.1, pinned)               │
│  会话 / 工具调用 / 审批 / WS 网关 / skill 装载    │
│   ├─ L1 插件: research-claw-core ── 注册 rc.* 方法/工具/hook
│   └─ L0 overlay: config + 提示词 + skills extraDirs
└───────────────┬────────────────────────────────┘
                │  better-sqlite3 (进程内)
┌───────────────▼────────────────────────────────┐
│  数据层: ~/.research-claw/library.db (WAL+FTS5)  │
└──────────────────────────────────────────────────┘

技能包: @wentorai/research-plugins —— 经 skills.load.extraDirs 装入基座
```

代码落点(易错点,务必记牢):**服务层与数据层都在 `extensions/research-claw-core/src/` 下**,仓库根的 `src/` 是空的。插件入口是单文件 `extensions/research-claw-core/index.ts`。

## 3. 耦合分层 L0–L3(本架构的核心 why)

RC 是 OpenClaw 的"卫星仓":既要深度定制,又要能跟随上游升级。做法是把每一处定制按**耦合强度**归到四层,层级越深、升级时维护成本越高,因此**能放浅就不放深**。

| 层 | 机制 | 改动面 | 升级风险 | 原则 |
|----|------|--------|----------|------|
| **L0** | 文件系统 overlay(config / 提示词 / skills extraDirs / .env / DB) | 0(全在 OC 包外) | 无 | 首选。新增定制优先走这里 |
| **L1** | Plugin SDK(`register(api)` 装载 TS 插件) | core 插件 | 低(类型检查兜底) | 服务/数据/工具/hook 都走这层 |
| **L2** | WS RPC v3 协议 | dashboard SPA | 中(协议版本 bump 要改前端) | 复用 OC 既有协议,不自造 |
| **L3** | pnpm patch(改 OC 包源码) | ~20 行 / 7 文件,仅 branding 字符串 | 高(每次升级要重打 patch) | **极度克制**,只改字符串不改逻辑 |

为什么这样排:L3 是唯一会因上游升级而硬性返工的层,所以 patch 必须小到"一眼能看懂、失败会响"——pnpm 在 patch 无法应用时会硬报错,不会静默吞掉。能用 L0 config 或 L1 插件解决的,绝不下沉到 L3。

> patch 文件版本锁定为 `patches/openclaw@2026.6.1.patch`,随 OC 版本号绑定。升级 OC = 重新生成该 patch + 跑测试。

## 4. 运行时数据流

dashboard **只**通过 WS RPC v3 与基座通信(与 OC 自带 Lit UI、移动端、macOS app 同一套协议),端口 `28789` **仅绑 loopback**。

- 帧类型:`req` / `res` / `event`(请求-响应 + 服务端单向事件)。
- 握手:`connect.challenge` → `connect` → `hello-ok`;loopback 模式只校验来源 IP 为 `127.0.0.1`/`::1`。
- 聊天走**事件流**而非请求-响应:客户端发 `chat.send`,服务端回一串 `chat.stream` 事件(`delta`/`final`/`aborted`/`error`)。
- 事件带单调递增 `seq`;客户端发现断号即用 `state.snapshot` 全量补齐(gap recovery)。

## 5. 后端:core 插件

单插件 `research-claw-core` 承载全部服务层。注册机制(以 `index.ts` 与各 `src/*/rpc.ts` 为权威源):

- **`registerGatewayMethod`**:少量直接挂到网关的方法。
- **`registerMethod` 桥接**:大量 `rc.*` 业务方法的注册入口,分散在 9 个模块的 `rpc.ts` 里。
- **命名空间约定**:每个模块用一个 `rc.<module>.*` 前缀,互不交叉。当前模块前缀:

  | 前缀 | 模块 | 前缀 | 模块 |
  |------|------|------|------|
  | `rc.lit` | 文献库 | `rc.monitor` | 监控/雷达 |
  | `rc.task` | 任务 | `rc.cron` | 定时 |
  | `rc.ws` | 工作区 | `rc.memory` | 记忆 |
  | `rc.review` | 论文评审 | `rc.ppt` | 汇报生成 |
  | `rc.provider`/`rc.model` | 模型供应商 | `rc.oauth`/`rc.auth` | 鉴权 |
  | `rc.session` | 会话 | `rc.dashboard`/`rc.app` | 面板/应用 |
  | `rc.notifications` | 通知 | `rc.heartbeat` | 心跳 |

- **Hooks**:插件挂在 OC 的生命周期钩子上——`before_prompt_build`、`session_start`/`session_end`、`before_tool_call`、`after_tool_call`、`gateway_start`。注意 `before_tool_call` 对**所有**工具(含内置)触发,`after_tool_call` 只对插件工具触发。

> 方法/工具的**数量**会随开发变化,本文不写死;要精确数字请直接数代码(见 §9)。

## 6. 数据层:SQLite

- **位置**:`~/.research-claw/library.db`(+ `-wal`/`-shm`),首次运行由插件自动建库;路径来自 config `plugins.entries.research-claw-core.config.dbPath`。
- **连接 pragma**(权威源 `src/db/connection.ts`,**实测值**):

  | pragma | 值 | 为什么 |
  |--------|----|--------|
  | `journal_mode` | `WAL` | 读写并发:agent 与 dashboard 会同时访问 |
  | `synchronous` | `FULL` | WAL 帧逐帧 fsync,**能扛 SIGKILL**(本地 agent 随时可能被强杀,数据不能损) |
  | `foreign_keys` | `ON` | 强约束,靠 FK 维护引用完整性 |
  | `busy_timeout` | `5000` | 锁竞争时最多等 5s,而非立即报错 |
  | `cache_size` | `-8000`(8MB) | 学术库规模下足够 |
  | `temp_store` | `MEMORY` | 临时表走内存 |

  > 取舍点:`synchronous=FULL` 比 `NORMAL` 慢,但本地单机、库不大,**用性能换"强杀不坏库"**——这是有意为之,别为提速悄悄降到 NORMAL。

- **Schema**:`SCHEMA_VERSION = 14`,权威源 `src/db/schema.ts`;约 22 张 `rc_` 常规表 + 2 张 FTS5 虚拟表 + 6 个触发器。表清单与 DDL 看代码,本文不复制。
- **迁移**:`src/db/migrations.ts`;无 `rc_schema_version` 表即判定为全新库,首访 fail-open 建库。

## 7. 前端:dashboard 状态管理

- 选型:React + Zustand(多个 `src/stores/*` 切片),而非 OC 原生 Lit。
- **硬约束:store 不直接持有/调用 gateway**。所有调用走共享 `rpc()` 帮助函数(内部取 `useGatewayStore` 的 client),事件订阅集中在 App 根的单个 `useGatewayEvents()` hook 里分发。这样连接生命周期只有一处真源,store 不会各自持有过期 client。
- **3 层连接活性检测**(浏览器 WS 检测不到半开 TCP,故自建):
  1. **Tick 看门狗**(`client.ts`):网关每 30s 广播 `tick`,客户端检测 `gap > tickInterval*2` 即 `close(4000)` 触发重连。
  2. **可见性恢复**(`App.tsx`):后台标签页的 `setInterval` 被 Chrome 限流,故 `visibilitychange→visible` 时立即查一次 tick 活性。
  3. **流停滞看门狗**(`chat.ts`):streaming 中若 60s 无 delta 则恢复;但 `pendingTools.length>0` 时**跳过**(工具调用本就可能跑几分钟)。
- 重连:指数退避 + 抖动(`reconnect.ts`,800ms 起，×1.7，封顶 15s);鉴权失败(`UNAUTHORIZED`/`FORBIDDEN`)**不重连**,直接报错。

## 8. 安全模型

- **网络**:网关只绑 `127.0.0.1:28789`,无反代/隧道/转发;loopback 模式不需账密(同 VS Code LSP 的信任模型)。威胁面因此收敛到"本机用户"。
- **人在环**:OC 的 exec 审批默认开启;shell/写文件/外部请求逐次审批。RC 自有工具因只读写本地数据,经 config `tools.alsoAllow` 预批。
- **密钥**:`ANTHROPIC_API_KEY` 等只存 `.env`(gitignored),OC 启动时经 dotenv 读取,绝不进 config 文件。残余风险主要是"用户误提交 `.env`"。
- **依赖**:`openclaw` 锁精确版本(无 `^`/`~`),patch 版本锁定、不匹配即硬报错。

## 9. 易变事实的权威源(避免本文过期)

凡是会随开发漂移的数字/清单,本文**不写死**,精确值永远以代码为准:

| 想知道 | 去哪数 |
|--------|--------|
| `rc.*` 方法总数 / 各模块方法 | `extensions/research-claw-core/src/*/rpc.ts` |
| 工具(tool)清单与签名 | core 插件 `src/` 内 tool 定义 + `openclaw.plugin.json` |
| DB 表 / 索引 / 触发器 | `src/db/schema.ts`(`SCHEMA_VERSION` 同处) |
| skills 数量 | `@wentorai/research-plugins` 的 `catalog.json` |
| OC 锁定版本 / patch 范围 | 根 `package.json` + `patches/openclaw@<ver>.patch` |
| hook 挂载点 | `index.ts` 内 `registerHook` 调用 |

---

> 相关:提示词与运行时行为见 [prompt-architecture.md](./prompt-architecture.md);插件注册细节见 [plugin-integration.md](./plugin-integration.md);各业务模块见 [modules/](./modules/);本文档体系导航见 [../00-reference-map.md](../00-reference-map.md)。
