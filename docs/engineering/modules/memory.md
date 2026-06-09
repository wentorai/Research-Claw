---
doc: engineering/modules/memory.md
audience: 开发者 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-06-09 依代码重建(原 memory-plugin-design 后端部分;UI 完整设想见 design-backlog)
source-of-truth: 代码优先(extensions/research-claw-core/src/memory/ + src/db/schema.ts);本文保留设计 why,表/方法清单以代码为准
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 14
---

# 记忆系统(memory)

> 跨会话的结构化记忆,借鉴 claude-mem 的"类型化 + 全文检索",叠加科研特色(关联文献/任务)。
>
> ⚠️ **实现状态**:**后端完整**(`src/memory/` 全套:service / rpc / tools / embeddings / vector-store / claude-mem-sync;表已进 schema)。**Dashboard 面板已建但未接入入口**——`MemoryPanel.tsx` 与 `stores/memory.ts` 存在,但 `LeftNav.tsx` **未挂 memory 段**,故当前 UI 不可达(`nav.memory` i18n 键已存在)。完整记忆面板的 UI 设想见 [../design-backlog/memory-dashboard-ui.md](../design-backlog/memory-dashboard-ui.md)。

## 1. 设计理念

四类记忆,与 RC 自身的 auto-memory 体系同构:

| 类型 | 用途 |
|------|------|
| **user** | 用户偏好、角色、知识背景 |
| **feedback** | 用户反馈、工作流偏好、被验证的判断 |
| **project** | 项目进展、团队分工、截止日期 |
| **reference** | 外部系统链接(Linear、Grafana 等) |

科研特色:记忆可**关联 `rc_papers` / `rc_tasks`**(`related_paper_id` / `related_task_id`),把"记住的事"挂回文献与任务上下文。

### 与 claude-mem 的差异(why)

| 维度 | claude-mem | RC memory |
|------|-----------|-----------|
| 场景 | 通用编程 | 学术研究 |
| 类型 | 观察/会话/摘要 | user/feedback/project/reference |
| 存储 | SQLite + Chroma | SQLite(FTS5)+ 本地向量 |
| 入口 | MCP 工具 | RPC + (规划中的)Dashboard 面板 |

为什么不照搬 claude-mem 的"观察/会话/摘要":那套贴合写代码;科研更关心**用户画像、被验证的偏好、项目死线、外部资料指针**,故重定义四类。

## 2. 模块组成

```
src/memory/
  service.ts           ← MemoryService:CRUD + 检索
  rpc.ts               ← rc.memory.* / .tags.* / .links.* / .stats(见 §4)
  tools.ts             ← agent 工具
  embeddings.ts        ← 向量嵌入
  vector-store.ts      ← 本地向量检索(语义搜索)
  claude-mem-sync.ts   ← 与 claude-mem 数据互通
  session*.ts          ← 会话级记忆
```

表:`rc_memories` + `rc_memory_tags` / `rc_memory_tag_links` / `rc_memory_links`,均 `ON DELETE CASCADE`(删主记忆自动清标签链/关联链)。

## 3. 几个核心 why

- **类型化 + FTS5**:记忆按 `type` 分类、经 FTS5 全文检索,而非线性翻历史。类型让"调出某类记忆"成为索引命中而非全表扫。
- **双向链接(links)**:`rc_memory_links` 仿 Notion 双链,记忆间可互指,检索一条能带出关联上下文。
- **隐私标记**:`is_private` 标敏感记忆,可在导出/注入时排除。
- **语义检索**:`embeddings.ts` + `vector-store.ts` 在关键词之外提供向量相似检索——FTS5 命中字面,向量命中语义,两者互补。

## 4. 易变事实的权威源

| 想知道 | 去哪数 |
|--------|--------|
| `rc_memories` 等表结构 | `src/db/schema.ts`(rc_memor* 段) |
| `rc.memory.*` 方法清单(含 tags/links/stats) | `src/memory/rpc.ts` 顶部注释 + 实现 |
| 工具清单/签名 | `src/memory/tools.ts` |
| 向量检索实现 | `src/memory/embeddings.ts` + `vector-store.ts` |
| 面板是否已接入 LeftNav | `dashboard/src/components/LeftNav.tsx` 的 `PanelTab` |

---

> 相关:完整记忆面板 UI 设想(部分实现)见 [../design-backlog/memory-dashboard-ui.md](../design-backlog/memory-dashboard-ui.md);DB 单一所有者见 [../plugin-integration.md](../plugin-integration.md);整体架构见 [../architecture.md](../architecture.md);文档体系导航见 [../../00-reference-map.md](../../00-reference-map.md)。
