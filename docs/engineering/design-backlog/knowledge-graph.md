---
doc: engineering/design-backlog/knowledge-graph.md
audience: 开发者 — 渠道 B(设计储备,未进代码)
status: ⛔ 未实现 · 设计储备 · 2026-06-09 从原 knowledge-graph-plugin.md 凝练存档
source-of-truth: 本文是**设计设想**,代码中无对应实现(已核对:无 rc_kg_* 表 / 无 knowledge_graph 模块)。落地前此文仅供参考,不代表现状
baseline: 写作时设想叠加于 OpenClaw 卫星架构
---

# 知识图谱(design-backlog)

> ⛔ **未实现**。本文是一份**设计储备**:把文献/笔记/任务/代码/概念/记忆连成可视化知识图谱。代码中**尚无任何实现**(无 `extensions/knowledge-graph/`、无 `rc_kg_*` 表)。保留它是为了不丢设计意图;真要做时以此为起点,但需重新对齐当时的 schema 与依赖。
>
> 注:本设计里"记忆/双向链接/语义检索"已被 [memory 模块](../modules/memory.md)**部分独立落地**(`rc_memory_links` 双链 + 向量检索)。知识图谱若上马,应复用而非重造 memory 的这部分。

## 1. 设计理念

把六类**节点**用六类**关系**连起来,叠加双链 + AI 自动关联 + 交互式可视化:

| 节点(Node) | 关系(Relation) |
|------|------|
| Paper(论文) | cites(引用) |
| Note(笔记) | mentions(提及) |
| Task(任务) | related_to(相关) |
| Code(代码) | depends_on(依赖) |
| Concept(概念) | contains(包含) |
| Memory(记忆) | derives_from(衍生) |

与现有系统集成:节点不另起炉灶,而是**桥接** `rc_papers` / `rc_tasks` / `workspace/` 既有实体(加论文/建任务时自动建节点)。

## 2. 关键设计取舍(why,供未来参考)

- **作为独立插件还是并入 core**:原稿设想独立 `extensions/knowledge-graph/`。但 RC 已收敛为**单插件聚合器**(见 [../plugin-integration.md](../plugin-integration.md) §1),若落地应作为 core 内一个模块 `src/graph/`,共用同一 DB owner,而非另开插件/另开连接。
- **可视化库**:推荐 `react-force-graph-2d` 或 `vis-network`(力导向图),`react-flow` 备选。节点按类型配色、关系按类型配线型(实/虚线)。
- **双向链接语法**:`[[node-id]]` 或 `[[node-id|显示文本]]`,正则 `\[\[([^\]|]+)(?:\|([^\]]+))?\]\]`,渲染成可跳转链接。与 memory 的 `rc_memory_links` 是同一思路,应统一。
- **AI 关联建议**(最远期):两路——语义相似(向量,阈值 ~0.7)+ 关键词共现(给出 reason/confidence)。依赖嵌入能力,memory 模块的 `embeddings.ts` / `vector-store.ts` 可复用。

## 3. 落地前必须重新确认

| 项 | 为什么 |
|----|--------|
| 是否并入 `research-claw-core` | RC 现行单插件聚合,不再新增独立插件 |
| 与 memory 模块去重 | 双链 / 向量检索已在 memory 落地,勿重造 |
| schema 对齐当时 SCHEMA_VERSION | 本稿表结构是旧设想,需按落地时的迁移体系重写 |
| 可视化库版本与体积 | 力导向图库较重,需评估对本地 SPA 启动的影响 |

---

> 相关:已落地的记忆/双链/向量见 [../modules/memory.md](../modules/memory.md);单插件聚合约束见 [../plugin-integration.md](../plugin-integration.md);文档体系导航见 [../../00-reference-map.md](../../00-reference-map.md)。
