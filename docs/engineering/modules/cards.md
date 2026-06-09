---
doc: engineering/modules/cards.md
audience: 开发者 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-06-09 依代码(protocol.ts + dashboard 渲染层)重写校核
source-of-truth: 代码优先。卡片契约权威 = `extensions/research-claw-core/src/cards/protocol.ts`;dashboard 镜像 = `dashboard/src/types/cards.ts`;渲染链路 = `dashboard/src/components/chat/CodeBlock.tsx`
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 14
---

# 消息卡片协议(Message Card Protocol)

> 模块:Dashboard 聊天渲染。Agent 在回复正文里发出 markdown 原生的 fenced JSON 卡片,
> dashboard 把已知类型解析为结构化 UI,其余一切优雅降级为带语法高亮的代码块。

> ⚠️ 本文**不写卡片数量定值之外的字段穷举**(字段会随版本增删)。卡片**唯一契约是 TypeScript interface**(`protocol.ts`),没有独立 JSON Schema 文件,也没有 Ajv 校验——下文凡涉及具体字段,以 `protocol.ts` 为准。

---

## 1. 设计哲学

卡片协议在 agent 输出与 Dashboard UI 之间架桥,**不引入私有传输层**。四条原则:

**Markdown 原生输出。** Agent 写标准 Markdown,结构化数据放进 fenced code block——正是人类读者预期它出现的位置。无自定义 XML 标签、无隐藏元数据、无二进制封帧。

**语言标签即卡片类型。** fenced block 的语言标识符同时充当卡片类型判别符。Dashboard 的 Markdown 渲染器把每个代码块的语言标签拿去与已知类型集 `CARD_TYPES` 比对:命中则富渲染成卡片,否则原样走默认语法高亮代码块。

**纯终端可读降级。** 当输出在终端、VS Code 预览或任何不认识 RC 卡片类型的 Markdown 渲染器里查看时,用户看到的是一个带语言标签(如 `paper_card`)的 JSON 代码块——上下文仍在,信息不丢。

**优雅降级。** 三种失败模式——未知类型、JSON 非法、流式未闭合——都被妥善处理,绝不崩溃、绝不吞内容、绝不留空占位。详见 §6。

### 为什么不用自定义协议?

考虑并否决了下列替代:

| 替代方案 | 否决原因 |
|---|---|
| HTML `<div data-card="...">` | 多数 Markdown 渲染器会剥掉;模型生成合法 HTML 不可靠 |
| `<!-- card: ... -->` 内联 JSON | 纯渲染器里不可见;模型易写坏 |
| 专用 `/card` API 端点 | 破坏流式会话模型;增加延迟 |
| 自定义 Markdown 指令(`:::`) | 非 CommonMark;解析器支持碎片化 |

带 JSON 载荷的 fenced code block,是可移植、对模型友好、可调试三者兼得的最优解。

---

## 2. 卡片类型清单

当前 **6 个**自定义卡片类型,定义在 `protocol.ts`(后端权威)并由 `dashboard/src/types/cards.ts` **逐字段镜像**(该文件头部注释明示"Verified against protocol.ts")。两处必须同步。

| 类型 | 必填字段 | 用途 | 典型来源 |
|---|---|---|---|
| `paper_card` | `title`, `authors` | 单篇学术论文 | 文献检索、监控、手动 |
| `task_card` | `title`, `task_type`, `status`, `priority` | 研究任务(human/agent/mixed) | 任务系统、heartbeat |
| `progress_card` | `period`, `papers_read`, `papers_added`, `tasks_completed`, `tasks_created` | 时段活动汇总 | heartbeat cron、手动 |
| `approval_card` | `action`, `context`, `risk_level` | 人在环审批请求 | HiL / exec-approvals |
| `file_card` | `name`, `path` | 工作区文件 | 文件操作 |
| `monitor_digest` | `monitor_name`, `source_type`, `target`, `total_found`, `findings` | 监控扫描摘要(N-监控:arxiv/github/rss/webpage/openalex/…) | 监控系统、定时扫描 |

> **可选字段、枚举值、子接口(如 `monitor_digest.findings: MonitorFinding[]`)一律去 `protocol.ts` 看,不在本文复制——会漂移。** `code_block` **不是**卡片类型:带已知编程语言标签的普通 fenced block 走语法高亮(§4)。

---

## 3. 约定格式

Agent 发出一个 fenced code block,语言标签 = 卡片类型,正文 = **单个 JSON 对象**:

````markdown
这是本次监控扫到的高相关论文:

```paper_card
{
  "title": "Attention Is All You Need",
  "authors": ["Vaswani, A.", "Shazeer, N."],
  "venue": "NeurIPS 2017",
  "doi": "10.48550/arXiv.1706.03762",
  "read_status": "unread"
}
```

它引入了支撑现代多数 LLM 的 Transformer 架构。
````

### 规则

1. **每块一个 JSON 对象。** 顶层不允许数组——多篇论文用多个 `paper_card` 块。`CodeBlock` 对非对象(数组/原始值)直接降级。
2. **只允许合法 JSON。** 无尾逗号、无单引号、无注释——解析直接用 `JSON.parse()`。
3. **卡片是正文的补充,绝不能独占整条消息。** Agent 必须在卡片前后写自然语言上下文。卡片是可视增强,不是解释的替代。
4. **语言标签需匹配 `CARD_TYPES` 集合成员**(小写下划线)。未命中则按编程语言走语法高亮,再不济按纯文本。
5. **不嵌套。** 卡片块内不能再含 fenced block(JSON 载荷自身可有嵌套对象/数组)。
6. **空白不敏感。** JSON 可美化可压缩;为终端可读性优先美化。

---

## 4. 解析与渲染链路(真实实现)

卡片渲染**没有独立解析器、没有 Ajv、没有 JSON Schema 文件**。它是 `react-markdown` 的 `components.code` 覆盖项——即 `dashboard/src/components/chat/CodeBlock.tsx`。流程:

```
Agent 消息(Markdown)
  └─ react-markdown 渲染,每个 code 节点交给 CodeBlock
       │  language = className 去掉 "language-" 前缀
       ├─ CARD_TYPES.has(language)?
       │    ├─ 是 → JSON.parse(code)
       │    │        ├─ 成功且为 plain object(非数组)
       │    │        │     → <ErrorBoundary fallback=代码块(json)>
       │    │        │         renderCard(language, data)  ← switch 派发到 6 个组件
       │    │        └─ JSON.parse 抛错(流式未闭合)
       │    │              → <CardPlaceholder cardType>  骨架,显示类型 label
       │    └─ 否 → SyntaxHighlightedBlock(Shiki 高亮 + Copy)
```

关键事实(均在 `CodeBlock.tsx` 可核):

- **类型判定**:`language && CARD_TYPES.has(language)`(`CARD_TYPES` 是 `types/cards.ts` 导出的 `Set`)。
- **"校验"仅两步**:`JSON.parse` + `data && typeof data === 'object' && !Array.isArray(data)`。没有 schema 校验——TS interface 是唯一契约,运行时不强制。
- **派发**:`renderCard()` 是一个**硬编码 switch**(6 个 case + default),组件**静态 import**(非 lazy、无 `CARD_COMPONENTS` map、无插件注册)。
- **组件崩溃**:外层 `<ErrorBoundary>`(`@/components/ErrorBoundary`)兜底,fallback 到 `SyntaxHighlightedBlock(json)`。
- **流式未闭合**:`JSON.parse` 抛错时**不**显示生 JSON,而是 `<CardPlaceholder>` 骨架(`CARD_LABELS` 按类型给中性 label),等闭合后重渲染。
- **语法高亮用 Shiki**(`@/utils/shiki-highlighter` 单例,主题 `github-dark`/`github-light`),**不是** Prism/highlight.js。

### 组件映射

| 卡片类型 | 组件 | 文件 |
|---|---|---|
| `paper_card` | `<PaperCard>` | `dashboard/src/components/chat/cards/PaperCard.tsx` |
| `task_card` | `<TaskCard>` | `…/cards/TaskCard.tsx` |
| `progress_card` | `<ProgressCard>` | `…/cards/ProgressCard.tsx` |
| `approval_card` | `<ApprovalCard>` | `…/cards/ApprovalCard.tsx` |
| `file_card` | `<FileCard>` | `…/cards/FileCard.tsx` |
| `monitor_digest` | `<MonitorDigest>` | `…/cards/MonitorDigest.tsx` |

### 卡壳与视觉(`CardContainer.tsx`)

所有卡片共用 `CardContainer` 外壳,遵循 HashMind 暗色终端美学:`bg.surface` 背景 + 1px 默认边 + **左侧 3px accent 边** + 圆角 8 + padding 16 + `margin 8px 0` + **`maxWidth` 默认 560**。

**accent 颜色是动态的,按卡片状态算,不是按类型定死:**

| 类型 | accent 取色逻辑 |
|---|---|
| `paper_card` | 按 `read_status`(`STATUS_COLORS`),缺省 `text.muted` |
| `task_card` | 按 `priority`(`PRIORITY_COLORS`),缺省 `#6B7280` |
| `progress_card` | 有 urgent → `#EF4444`,否则 `accent.blue` |
| `approval_card` | 按 `risk_level`(`RISK_BORDER_COLORS`),缺省 `#F59E0B` |
| `monitor_digest` | `total_found > 0` → `#10B981`,否则 `text.muted` |
| `file_card` | 按文件类型(`fileInfo.color`) |

> 具体色值随主题 token 变,去各组件源码看,别在本文锁死。

---

## 5. 第二通道:卡片通知

除主渲染外,`dashboard/src/stores/chat.ts` 的 `extractCardNotifications()` 用一条正则旁路扫 assistant 消息:

```
/```(progress_card|monitor_digest|approval_card)\s*\n([\s\S]*?)```/g
```

它**只认 3 类**——`progress_card` / `monitor_digest` / `approval_card`——把它们转成系统通知(如 heartbeat 进度、监控有新发现、待审批),让用户在不滚回聊天时也能感知。其余卡片不进此通道。这是"渠道 B"通知机制,与 §4 的可视渲染并行、互不替代。

---

## 6. 优雅降级与不变量

### 失败模式 → 渲染输出

| 失败 | 检测 | 输出 |
|---|---|---|
| 未知语言标签 | 不在 `CARD_TYPES`,也非已知编程语言 | 纯文本代码块(Shiki 退 `text`) |
| 已知类型但 JSON 非法 / 流式未闭合 | `JSON.parse` 抛错 | `<CardPlaceholder>` 骨架(按类型 label) |
| 已知类型、合法 JSON 但顶层非对象 | 数组/原始值 → object guard 失败 | 落到 §4 末路:走语法高亮代码块 |
| 已知类型、对象合法但组件渲染崩溃 | 外层 `ErrorBoundary` 捕获 | fallback 到 `SyntaxHighlightedBlock(json)` |

> 注意:实现里没有"Parse Error / Validation Error / Render Error" 三色 badge,也没有 schema 校验失败这一档——因为根本没有 schema 校验。失败一律降级到代码块或骨架。

### 硬不变量

**内容绝不隐藏。** 渲染器若产不出卡片,用户**必须**仍能看到原始 JSON 载荷或骨架。静默吞内容是 bug。这条不变量覆盖每一种失败模式。

---

## 7. Agent 侧指引

Agent **何时发哪种卡片、字段长什么样**,权威在 `AGENTS.md §9 Output Cards`(内联给出 6 个卡片的 schema 摘要)+ `Output Cards` skill。本工程文档不复制那份指引、也不写 token 预算定值——以 L1 提示词为准。要点:

- 数据类工具调用后发对应卡片;`paper_card` 用于任何论文引用;`task_card` 用于任务增改列;`progress_card` 用于活动汇总;`approval_card` 用于 HiL 审批;`monitor_digest` 用于监控摘要;`file_card` 用于引用自己创建/修改的工作区文件。
- 卡片务必配自然语言上下文,不确定时优先纯文本。

---

## 8. 扩展:新增一个卡片类型

新增类型需改下列位置(**无插件注册 API**,renderCard 是硬编码 switch):

1. **后端契约** `extensions/research-claw-core/src/cards/protocol.ts`:加 interface、并入 `CardType` union 与 `CARD_TYPES` 集合、并入 `MessageCard` union。
2. **dashboard 镜像** `dashboard/src/types/cards.ts`:逐字段复制上一步(含 `CardType` / `CARD_TYPES`)。两处不同步会导致解析或类型错位。
3. **组件** `dashboard/src/components/chat/cards/XxxCard.tsx`:用 `CardContainer` 外壳,自定 accent 取色。
4. **渲染派发** `dashboard/src/components/chat/CodeBlock.tsx`:`renderCard` switch 加 case;`CardPlaceholder.tsx` 的 `CARD_LABELS` 加条目。
5. **Agent 指引** `AGENTS.md §9`:加该类型 schema 摘要(必要时同步 Output Cards skill)。
6. (可选)若该类型需进通知,改 `chat.ts` 的 `CARD_NOTIFICATION_RE`。

向后兼容:加**可选**字段即可——`JSON.parse` 不强制 schema,旧载荷与旧渲染器都仍工作。破坏性改动(改必填字段/重命名)应新建类型而非原地改。

---

## 9. 易变事实权威源

| 想知道 | 看这里(勿背诵进本文) |
|---|---|
| 卡片类型清单、每类字段/枚举 | `extensions/research-claw-core/src/cards/protocol.ts` |
| dashboard 类型镜像是否同步 | `dashboard/src/types/cards.ts`(头部注释 + 逐字段比对) |
| 解析判定、降级、Shiki 高亮 | `dashboard/src/components/chat/CodeBlock.tsx` |
| 卡壳样式、maxWidth、accent | `dashboard/src/components/chat/cards/CardContainer.tsx` + 各 `*Card.tsx` |
| 流式骨架 label | `dashboard/src/components/chat/cards/CardPlaceholder.tsx` |
| 通知旁路(3 类) | `dashboard/src/stores/chat.ts` → `extractCardNotifications` |
| Agent 何时发卡、字段 schema | `AGENTS.md §9` + `Output Cards` skill |

---

## 附:完整示例消息

````markdown
早上好!这是今天的研究简报。

## 监控扫描

你的 arXiv 追踪过夜扫到 12 篇"图神经网络分子性质预测"新论文,高相关如下:

```monitor_digest
{
  "monitor_name": "GNN 分子性质预测追踪",
  "source_type": "arxiv",
  "target": "graph neural networks molecular property prediction",
  "schedule": "0 7 * * *",
  "total_found": 12,
  "findings": [
    {
      "title": "Equivariant Graph Transformers for Molecular Energy Prediction",
      "url": "https://arxiv.org/abs/2603.04521",
      "summary": "直击你的能量预测基准,声称较 SchNet 提升 15%。"
    },
    {
      "title": "Scalable Message Passing for Large Molecular Graphs",
      "url": "https://arxiv.org/abs/2603.04880",
      "summary": "子图采样技术,或可缓解你蛋白复合物上的 OOM。"
    }
  ]
}
```

第一篇尤其相关,我拉了详情:

```paper_card
{
  "title": "Equivariant Graph Transformers for Molecular Energy Prediction",
  "authors": ["Chen, W.", "Liu, Y.", "Zhang, H."],
  "venue": "arXiv preprint",
  "year": 2026,
  "arxiv_id": "2603.04521",
  "read_status": "unread",
  "tags": ["GNN", "molecular-properties", "transformers"]
}
```

## 昨日进度

```progress_card
{
  "period": "yesterday",
  "papers_read": 3,
  "papers_added": 5,
  "tasks_completed": 2,
  "tasks_created": 1,
  "writing_words": 850,
  "highlights": ["读完 SchNet 消融", "方法学 3.2 节初稿达 850 字"]
}
```

## 待办

```task_card
{
  "id": "task_2026_03_04_001",
  "title": "复现 DimeNet++ 论文 Table 3",
  "task_type": "mixed",
  "status": "in_progress",
  "priority": "high",
  "deadline": "2026-03-14T23:59:00Z",
  "related_paper_title": "DimeNet++: Fast Directional Interatomic Potentials"
}
```

要我先帮你精读 EquiGT,还是先推进 DimeNet++ 复现?
````

---

*文档结束 — 消息卡片协议*
