---
doc: engineering/modules/literature.md
audience: 开发者 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-06-09 依代码重建(原 03a 文献库设计)
source-of-truth: 代码优先(extensions/research-claw-core/src/literature/ + src/db/schema.ts);本文保留设计 why,表/字段/工具清单以代码为准
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 14
---

# 文献库(literature)

> 本地文献管理模块。所有论文落在单个 SQLite 文件,全部操作皆为 agent 工具。本文讲**为什么这样设计**,schema 与工具清单看 `src/literature/` 与 `src/db/schema.ts`(见 §6)。

## 1. 设计原则

| 原则 | 含义 |
|------|------|
| **本地优先** | 全部数据在单个 SQLite 文件 `{projectRoot}/.research-claw/library.db`,无云依赖 |
| **Agent 原生** | 每个操作都是 agent 工具——检索/加库/打标签/导出无需人工介入(读操作) |
| **破坏性操作人在环** | 删除、批量改写需经 chat 显式确认(`approval_card`) |
| **schema 隔离** | 表名一律 `rc_` 前缀,避免与 OpenClaw 内部表冲突 |
| **可扩展不迁移** | `rc_papers.metadata` 是 JSON 列——加字段不必改 schema、不必跑迁移 |

> **为什么 metadata 用 JSON 列而非独立列**:论文元数据形态发散(不同来源字段不一),把易变字段塞进一个 JSON 列,避免每加一个来源就动 schema、写迁移。稳定且要索引/排序的字段(标题、年份、DOI、created_at)才升为真列。

## 2. 模块组成

```
src/literature/
  service.ts   ← LiteratureService:全部 DB 操作的唯一入口
  tools.ts     ← agent 工具定义(TypeBox schema)
  rpc.ts       ← 网关 RPC 处理器(rc.lit.*)
  zotero.ts    ← ZoteroBridge:只读导入
```

数据库连接由插件单一持有,本模块拿 `getDb()` 句柄,自己从不开连接(见 [../plugin-integration.md](../plugin-integration.md) §5)。

## 3. 几个核心 why

- **BibTeX citation key 生成**:按 `作者姓+年份+标题首词` 规则生成稳定 key,冲突时追加字母后缀。要的是**跨会话稳定**——同一篇论文每次生成同样的 key,导出/引用才不漂移。
- **DOI 去重**:加库前按规范化 DOI 查重,命中则更新而非插入。DOI 是论文的天然主键,优先于标题模糊匹配(标题易因大小写/标点不同而漏判)。
- **Zotero 只读**:`zotero.ts` 只**导入**、绝不回写用户的 Zotero 库——避免污染用户既有资产,边界清晰。

## 4. 全文检索(FTS5)

- 检索走 SQLite **FTS5** 虚拟表,而非 `LIKE` 扫描——量大时 `LIKE` 慢且不排序相关度。
- **触发器同步**:`rc_papers` 的写操作经触发器同步进 FTS 表。**删除用 `BEFORE DELETE` 触发器**:必须在主行还在时把对应 FTS 行删掉,否则 FTS 索引残留指向已删行,后续检索命中幽灵结果。这是 FTS5 外部内容表的经典坑,务必保持 BEFORE 时序。

## 5. 交互路由

- **简单操作**(切已读、加星)→ 直接 `rc.lit.*` RPC,面板即时反映。
- **复杂操作**(按 DOI 加论文、带上下文整理)→ 预填 chat 交给 agent(带元数据抓取与审批)。详见 [../interaction-design.md](../interaction-design.md) §1.1。

## 6. 易变事实的权威源

| 想知道 | 去哪数 |
|--------|--------|
| `rc_papers` 等表结构/字段 | `src/db/schema.ts` |
| 工具清单/签名 | `src/literature/tools.ts` |
| `rc.lit.*` 方法清单 | `src/literature/rpc.ts` |
| FTS 表与触发器定义 | `src/db/schema.ts`(FTS5 段) |
| 当前 SCHEMA_VERSION | `src/db/schema.ts` 常量 |

---

> 相关:整体架构与 SQLite pragma 见 [../architecture.md](../architecture.md);插件装载与 DB 单一所有者见 [../plugin-integration.md](../plugin-integration.md);面板交互见 [../interaction-design.md](../interaction-design.md);文档体系导航见 [../../00-reference-map.md](../../00-reference-map.md)。
