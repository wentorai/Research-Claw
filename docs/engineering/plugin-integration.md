---
doc: engineering/plugin-integration.md
audience: 开发者 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-06-09 依代码重建(合并原 05 集成指南 + 03f 聚合规格)
source-of-truth: 代码优先(extensions/research-claw-core/index.ts + src/*/rpc.ts + openclaw.plugin.json);本文保留集成 why,清单以代码为准
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 14
---

# 插件集成(research-claw-core)

> RC 的全部服务层由**单个** OpenClaw 插件 `research-claw-core` 聚合。本文讲它怎么挂到 OC 运行时、为什么这样组织。具体方法/工具/表的**数量与签名以代码为准**(见 §9),本文不复制清单。

## 1. 定位:单插件聚合器

- **一个插件、多个模块**:一份 `openclaw.plugin.json` + 一个 `index.ts` 入口;功能代码在 `src/literature/`、`src/tasks/`、`src/workspace/`、`src/monitor/`、`src/db/`、`src/cards/` 等。各功能模块是**无插件感知**的普通 TS 模块,由 `index.ts` 导入并接到 OC。
- **数据库单一所有者**:**只有**本插件打开 SQLite 连接;模块拿到的是 `Database` 句柄,自己从不构造连接(见 [architecture.md](./architecture.md) §6)。
- **对 OC 内部零耦合**:全部集成走文档化的 Plugin SDK(`api.registerTool`、`api.on` 等);唯一例外是 branding 的 pnpm patch(~20 行/7 文件,在插件之外,见 [install-startup.md](./install-startup.md))。
- **缺库 fail-open**:首次访问时若 DB 文件不存在,按全 schema 自动建库;有待迁移则自动跑。

## 2. 装载

- OC 用 **jiti 直接加载 `.ts`**——`dist/` 从不被使用。改插件代码后重启 gateway 即生效(无需先 build)。
- `openclaw.plugin.json` 的 `configSchema` 在**装载时校验**;config 非法则插件**不激活**(因此 example config 必须能过 schema,否则新用户启动即崩)。
- 生命周期:`register(api)` 在 gateway 启动时调一次。

## 3. 注册机制

`index.ts` 在 `register(api)` 里把模块接到 OC。主要注册面:

| API | 用途 | 关键点 |
|-----|------|--------|
| `api.registerTool(factory)` | 注册 agent 工具 | factory 收到运行时上下文,返回工具定义**或 `null`** |
| `registerGatewayMethod` | 直接挂网关的少量方法 | dashboard 经 WS 调用 |
| `registerMethod`(桥接) | 大量 `rc.*` 业务方法的注册入口 | 分散在 9 个模块的 `src/*/rpc.ts` |
| `api.registerHttpRoute` | HTTP 路由(如文件上传) | 带 `auth` 策略,见 §6 |
| `api.on(hook, handler, {priority})` | 生命周期 hook | priority 默认 100,**越小越早** |
| service / `getDb()` | SQLite 单例连接 | 工具/RPC 在**调用时**取 `getDb()`,非注册时 |

### 3.1 注册顺序(有意为之)

1. **Config 先**——后续都依赖解析后的 config 值。
2. **DB service 先于 tools/RPC**——它们持有 service 引用,在**调用时**(非注册时)调 `getDb()`,故 service 此刻无需已启动。
3. **Tools 先于 RPC**——无硬依赖,但工具是主接口,先列清晰。
4. **Hooks 最后**——hook 常引用上面注册的 tools/services。

### 3.2 Tool factory 返回 null(核心 why)

工具用 factory 注册:factory 拿到运行时上下文,**上下文不满足就 `return null`**,该工具便不注册。例如 workspace 工具在没有 `workspaceDir` 时返回 null(`src/workspace/tools.ts`)。这让工具集**随上下文条件化**,而不是全量硬挂——签名写错(把 `(params, context)` 写反)会静默失败,务必照 SDK 签名。

### 3.3 `rc.*` 命名空间约定

每个模块用一个 `rc.<module>.*` 前缀,互不交叉(`rc.lit`/`rc.task`/`rc.ws`/`rc.monitor`/`rc.memory`/`rc.review`/…)。完整前缀表见 [architecture.md](./architecture.md) §5。

## 4. Hook 集成

- RC 挂在 OC 的:`before_prompt_build`、`session_start`/`session_end`、`before_tool_call`、`after_tool_call`、`gateway_start`。
- **作用域差异**:`before_tool_call` 对**所有**工具(含内置)触发;`after_tool_call` 只对插件工具触发。
- **priority**:`api.on(hook, handler, { priority })`,默认 100,**数字越小越早执行**(代码实测用 `{priority:50}`、`{priority:90}` 控制顺序)。
- **`before_prompt_build` 上下文注入**:hook 返回 `{ prependContext?, appendContext? }` 把研究上下文拼进 system prompt——这是 RC 在 bootstrap 文件之外动态注入信息的主路径(与提示词系统的关系见 [prompt-architecture.md](./prompt-architecture.md))。

## 5. SQLite 生命周期

- 位置/pragma/schema 见 [architecture.md](./architecture.md) §6。
- **单例连接经 service 暴露**:`getDb()` 返回同一连接;tools/RPC 在调用时取,保证全插件一个 DB owner。
- **fail-open 建库 + 自动迁移**:首访无库即建、有待迁移即跑(`src/db/migrations.ts`)。

## 6. 鉴权策略(HTTP 路由)

`registerHttpRoute` 的 `auth` 字段(默认 `gateway`):

- `auth: "gateway"` —— 由网关内置 auth 保护路由。
- `auth: "plugin"` —— 插件自管鉴权。

文件上传路由 `POST /rc/upload` 走 `loopback` 鉴权(只信本机来源),与网关只绑 `127.0.0.1` 的威胁模型一致(见 [architecture.md](./architecture.md) §8)。

## 7. 测试

- 插件测试用 vitest + in-memory SQLite;mock PluginApi 提供 `_hooks`/`registerTool` 等以断言注册。
- Dashboard 侧必须写 parity 测试(真实 gateway payload fixtures),**禁止 mock-first**。
- 改 `index.ts` 后:TS 编译通过 ≠ 运行时正确,**必须启动 gateway + 看 dashboard 验证**。

## 8. 配置项

`openclaw.plugin.json` 的 `configSchema`(权威源,字段如 `dbPath`/`autoTrackGit`/`defaultCitationStyle`/`heartbeatDeadlineWarningHours`)。运行时经 `api.pluginConfig` 注入,建议用 TypeBox 做类型安全解析。

## 9. 易变事实的权威源

| 想知道 | 去哪数 |
|--------|--------|
| 工具清单/签名 | `src/*/tools.ts` + `openclaw.plugin.json` |
| `rc.*` 方法清单 | `src/*/rpc.ts`(9 个) |
| hook 挂载点/优先级 | `index.ts` 的 `api.on(...)` 调用 |
| config 字段 | `openclaw.plugin.json` 的 `configSchema` |
| OC 兼容版本 | `openclaw.plugin.json` 的 `openclaw` 字段 + 根 `package.json` |

---

> 相关:整体架构见 [architecture.md](./architecture.md);提示词/上下文注入见 [prompt-architecture.md](./prompt-architecture.md);各业务模块见 [modules/](./modules/);文档体系导航见 [../00-reference-map.md](../00-reference-map.md)。
