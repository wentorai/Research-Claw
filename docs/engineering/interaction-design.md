---
doc: engineering/interaction-design.md
audience: 开发者 / 设计 — 渠道 B(仓库按需阅读,不注入运行时)
status: 现行 · 2026-06-09 依代码重建(布局对齐当前 LeftNav 八段)
source-of-truth: 代码优先(dashboard/src/components/);本文以交互哲学 why 为主,布局清单以组件为准
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 14
---

# Dashboard 交互设计

> 本文讲 RC dashboard"为什么这样交互"。具体像素/组件以 `dashboard/src/components/` 为准;
> 本文保留的是代码里看不出的设计取舍。

## 1. 核心哲学:Chat is the OS

RC 是 **agent 中心**的交互模型——聊天窗口不是侧边功能,而是研究者操作系统的主入口。复杂动作最终都经过与 agent 的一轮对话。

| # | 原则 | 含义 |
|---|------|------|
| 1 | **对话优先** | 复杂操作(文献检索、任务规划、写作)一律走 chat;面板是读多写少的视图,chat 是写路径 |
| 2 | **Agent 即搜索引擎** | **没有 `Cmd+K` 命令面板**。要找东西就问 agent,它会搜记忆/文献/工作区/网络。这是刻意设计,不是缺失 |
| 3 | **面板是投影** | 各导航面板是 agent 所管状态的实时视图;简单 CRUD(勾选、加星)可直接操作,凡需判断的走 chat |
| 4 | **少装饰、多内容** | 暗色终端美学,克制装饰,强调色仅用于交互元素与状态 |
| 5 | **人在环保留** | agent 执行破坏性/高成本动作前,必须经 chat 里的 `approval_card` 显式审批 |
| 6 | **本地优先、私密** | 数据全在本机,无遥测,除非用户显式配置,否则不上云 |

### 1.1 交互路由规则

每个用户操作落入两类之一:

| 类别 | 路由 | 例子 |
|------|------|------|
| **简单** | 直接 Plugin RPC 调用 | 切已读、加星、勾选任务、重排列表 |
| **复杂** | 打开 chat 并预填消息 | 按 DOI 加论文、带上下文建任务、开写作会话、配置雷达 |

> 为什么分两类:面板能即时反映 agent 状态,但"需要判断"的动作交给 agent 才能带上下文与审批;直接 RPC 只留给无歧义的轻操作。

## 2. 布局

当前布局由以下组件构成(`dashboard/src/components/`):

```
┌────────────────────────────────────────────────────────┐
│ TopBar (Logo · 通知 · Agent 状态 · 主题 · 头像)          │
├───────┬────────────────────────────┬────────────────────┤
│ Left  │      中央 Chat 区           │   RightPanel       │
│ Nav   │  (消息流 + 卡片 + 输入栏)    │  (当前导航段的视图) │
│ 8 段  │                            │                    │
├───────┴────────────────────────────┴────────────────────┤
│ StatusBar (连接 · token 上下文 · 不显示花费)              │
└────────────────────────────────────────────────────────┘
```

- **LeftNav**:8 个功能段(权威源 `components/LeftNav.tsx` 的 `PanelTab`)——`library` 文献库 · `workspace` 工作区 · `review` 评审 · `tasks` 任务 · `monitor` 监控 · `supervisor` 质量管控 · `extensions` 扩展 · `settings` 设置。LeftNav 同时承载**会话切换器**(会话 = Session;"项目"为未来 project-scoping 预留,当前 UI 不用此词)。
- **中央 Chat**:始终可见,是写路径;agent 回复里嵌 `*_card`(见 [modules/cards.md](./modules/cards.md))。
- **RightPanel**:渲染当前导航段对应面板(`components/panels/`)。
- **可折叠**:LeftNav 可折叠为图标轨(icon rail)。

> 注:历史设计稿曾是"3 栏 + 右侧 5 tab",现已演进为 **LeftNav 八段驱动**。具体导航项以 `LeftNav.tsx` 为准,本文不写死数量随版本变化的细节。

## 3. 设计语言:HashMind Dark Cyberpunk Terminal

哑光暗色面、等宽强调、微妙描边、极简图标——要像研究终端,而非消费级 SaaS。

- 主强调 **Lobster Red `#EF4444`**(交互元素、品牌)
- 次强调 **Academic Blue `#3B82F6`**(链接、信息徽标)
- 字体:Inter(UI)/ JetBrains Mono(代码、token 计数、状态栏)
- 圆角:卡片 6px / 按钮输入 4px / 徽标 2px
- 立面:不用投影,用 `1px rgba(255,255,255,0.06)` 描边
- 主题:dark 默认 + light(暖纸 `#FFFBF5`)

## 4. 刻意排除项(及理由)

这些"没有"是设计决定,别当遗漏补回来:

| 排除 | 为什么 |
|------|--------|
| **`Cmd+K` 搜索面板** | agent 就是搜索引擎;用户把查询打进 chat 输入框 |
| **成本/金额显示** | token 计数仅用于上下文窗口感知;显示花费会制造焦虑、抑制探索。需成本追踪的用户去 provider 控制台看 |

---

> 相关:输出卡片协议见 [modules/cards.md](./modules/cards.md);各面板对应的后端模块见 [modules/](./modules/);文档体系导航见 [../00-reference-map.md](../00-reference-map.md)。
