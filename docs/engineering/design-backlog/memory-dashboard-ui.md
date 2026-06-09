---
doc: engineering/design-backlog/memory-dashboard-ui.md
audience: 开发者 / 前端 — 渠道 B(设计储备,部分已落地)
status: 🟡 部分实现 · 设计储备 · 2026-06-09 从原 memory-plugin-design §四 凝练存档
source-of-truth: 后端完整(见 ../modules/memory.md);本文是**完整记忆面板的 UI 设想**,当前仅 MemoryPanel.tsx 落地且未接入 LeftNav
baseline: OpenClaw 2026.6.1 · DB SCHEMA_VERSION 14
---

# 记忆面板 UI(design-backlog)

> 🟡 **部分实现**。记忆**后端完整**(见 [../modules/memory.md](../modules/memory.md))。Dashboard 侧目前只有 `MemoryPanel.tsx` + `stores/memory.ts`,且**未接入 LeftNav**(无导航入口,`nav.memory` i18n 键已存在但不可达)。本文保存**完整记忆面板的 UI 设想**,作为把后端能力暴露给用户的落地蓝图。

## 1. 完整面板设想(组件分解)

原设计把记忆面板拆成一套组件,远多于当前的单个 `MemoryPanel.tsx`:

```
Memory Panel
├── MemoryList.tsx        # 记忆列表主视图
├── MemoryDetail.tsx      # 记忆详情
├── MemoryEditor.tsx      # 编辑器
├── MemorySearch.tsx      # 搜索栏(关键词 + 类型 + 标签 + 排序)
├── TagManager.tsx        # 标签管理
├── StatsView.tsx         # 统计视图
├── SuggestionsPanel.tsx  # AI 建议面板
└── components/
    ├── MemoryCard.tsx    # 记忆卡片(类型图标+色/标签/访问时间+次数/操作)
    ├── TypeFilter.tsx    # 四类筛选器(user/feedback/project/reference)
    ├── TagCloud.tsx      # 标签云
    ├── LinkView.tsx      # 双向链接视图(入链/出链分栏,点击跳转)
    └── AccessHistory.tsx # 访问历史
```

## 2. 关键 UI 取舍(why)

- **类型筛选器配色**:user 蓝 `#3B82F6` / feedback 绿 `#10B981` / project 橙 `#F59E0B` / reference 紫 `#8B5CF6`——四类一眼可分,与 memory 后端的 `type` 枚举一一对应。
- **搜索两模式**:索引模式(只显名称/描述/类型,快速扫)+ 详情模式(全文)。借鉴 claude-mem 的"先索引后详情"工作流,避免一上来全文刷屏。
- **LinkView 双栏**:入链 / 出链分开显示,每条带上下文、可点击跳转——把 `rc_memory_links` 的双向关系做成 Notion 式导航。
- **访问统计可见**:卡片显示"最后访问 + 访问次数",让高频记忆自然浮现(后端已有 `accessed_at` / `access_count` 字段与索引)。

## 3. 落地路径(后端已就绪,差前端接线)

| 步骤 | 状态 |
|------|------|
| 记忆表 + 索引 + FTS | ✅ 已在 schema |
| `rc.memory.*` / tags / links / stats RPC | ✅ 已实现 |
| `stores/memory.ts` | ✅ 存在 |
| `MemoryPanel.tsx` | 🟡 存在,功能未必覆盖上面全套组件 |
| **接入 LeftNav 导航段** | ⛔ 未接,当前不可达 |
| 完整组件套(Detail/Editor/TagManager/Stats/Suggestions/LinkView) | ⛔ 多为设想 |

> 最小可用路径:把 memory 段加进 `LeftNav.tsx` 的 `PanelTab`,让现有 `MemoryPanel.tsx` 可达,再按需补组件。后端无需改动。

---

> 相关:记忆后端(已实现)见 [../modules/memory.md](../modules/memory.md);LeftNav 导航约定见 [../modules/dashboard-ui.md](../modules/dashboard-ui.md) 与 [../interaction-design.md](../interaction-design.md);文档体系导航见 [../../00-reference-map.md](../../00-reference-map.md)。
