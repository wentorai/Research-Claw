---
doc: engineering/modules/tasks.md
audience: 开发者 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-06-09 依代码重建(原 03b 任务系统设计)
source-of-truth: 代码优先(extensions/research-claw-core/src/tasks/ + src/db/schema.ts);本文保留设计 why,字段/排序/工具清单以代码为准
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 14
---

# 任务系统(tasks)

> 科研任务清单。核心定性:**按截止日期排序的列表,不是看板(Kanban)**。本文讲设计取舍,schema 与工具清单看 `src/tasks/`(见 §5)。

## 1. 设计哲学:deadline 排序列表,而非看板

科研工作绕着**截止日期**转(会议投稿、基金申请、实验排期)。一条按 deadline 排序、已完成项可折叠的列表,比多列看板更聚焦、更易扫读。所以 RC **刻意不做** Kanban——别按"待办/进行中/完成"分列。

## 2. 核心原则

| 原则 | 理由 |
|------|------|
| **deadline 优先排序** | 最紧急的永远在顶部,一眼可见 |
| **人与 agent 同列** | 视角切换按 `task_type` 过滤,而非拆成两个系统 |
| **完成项折叠** | done/cancelled 收进底部 "Completed (N)",不占视线 |
| **子任务一层嵌套** | `parent_task_id` 只允许**一层**——再深就成项目管理工具了,违背"轻量清单"定位 |
| **论文关联** | 任务可引用 `rc_papers` 带研究上下文 |
| **活动留痕** | 每次变更写 `rc_activity_log` |

## 3. 展示顺序(核心 why)

排序规则刻意分四档,而非单纯按 deadline:

1. **逾期**(过 deadline 且未完成)—— deadline ASC(最逾期在前)
2. **有 deadline** —— deadline ASC(最近的在前)
3. **无 deadline** —— priority DESC(urgent > high > medium > low),再按 `created_at` ASC
4. **已完成**(折叠)—— `completed_at` DESC

并列再按 priority、再按 `created_at` 打破。为什么"无 deadline"落到第三档而非混排:没有死线的任务不该挤掉有死线的,但也不能沉底看不见,故按优先级单列一档。

## 4. 视角切换

| 视角 | 过滤 | 说明 |
|------|------|------|
| **All** | 无 | 全部任务 |
| **My Tasks** | `task_type = 'human'` | 研究者自己的任务 |
| **Agent** | `task_type IN ('agent','mixed')` | agent 参与的任务 |

视角选择持久化在 local storage——人和 agent 共用一份列表,靠视角过滤而非分库,保证两者的任务能互相引用、统一排序。

## 5. 易变事实的权威源

| 想知道 | 去哪数 |
|--------|--------|
| `rc_tasks` 字段(含 `task_type`/`parent_task_id`/`priority`) | `src/db/schema.ts` |
| 工具清单/签名 | `src/tasks/tools.ts` |
| `rc.task.*` 方法清单 | `src/tasks/rpc.ts` |
| 排序实现 | `src/tasks/service.ts` 的查询/排序逻辑 |

---

> 相关:任务面板与 `task_card` 见 [../interaction-design.md](../interaction-design.md) 与 [cards.md](./cards.md);心跳如何提醒临近 deadline 见 [../prompt-architecture.md](../prompt-architecture.md);整体架构见 [../architecture.md](../architecture.md);文档体系导航见 [../../00-reference-map.md](../../00-reference-map.md)。
