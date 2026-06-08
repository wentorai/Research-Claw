# Research-Claw 记忆管理插件设计

> 借鉴 claude-mem 的核心思想，为科研场景定制记忆系统

## 一、设计理念

### 1.1 核心概念 (借鉴 claude-mem + Notion)

```
┌─────────────────────────────────────────────────────────────┐
│                   Research-Claw Memory System               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Memory Types (4 种类型)                                    │
│  ├── User      - 用户偏好、角色、知识背景                    │
│  ├── Feedback  - 用户反馈、工作流偏好、验证的判断            │
│  ├── Project   - 项目进展、团队分工、截止日期                │
│  └── Reference - 外部系统链接 (Linear、Grafana 等)          │
│                                                             │
│  Features (从 claude-mem 借鉴)                              │
│  • 持久化存储 - 跨会话保持上下文                            │
│  • 智能搜索 - FTS5 全文搜索 + 类型筛选                      │
│  • 自动捕获 - 从对话中提取记忆 (可选)                       │
│  • Web Viewer UI - Dashboard 集成管理界面                   │
│  • 引用系统 - 用 ID 引用记忆                                │
│  • 隐私控制 - 标记敏感内容                                  │
│                                                             │
│  Research-Specific Features (科研特色)                      │
│  • 文献关联 - 记忆与 rc_papers 关联                         │
│  • 任务关联 - 记忆与 rc_tasks 关联                          │
│  • 实验记录 - 实验参数、结果、问题记录                      │
│  • 写作风格 - 学术写作偏好、术语习惯                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 与 claude-mem 的差异

| 特性 | claude-mem | Research-Claw Memory |
|------|-----------|---------------------|
| **目标场景** | 通用编程 | 学术研究 |
| **记忆类型** | 观察、会话、摘要 | 用户、反馈、项目、引用 |
| **搜索方式** | MCP 工具 (3 层) | Dashboard UI + RPC |
| **存储** | SQLite + Chroma | SQLite (FTS5) |
| **集成** | Claude Code | OpenClaw + Dashboard |
| **特色** | 代码上下文 | 文献、实验、写作风格 |

## 二、数据库设计

### 2.1 记忆表 (与现有架构集成)

```sql
-- 记忆表 (主表)
CREATE TABLE rc_memories (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK(type IN ('user', 'feedback', 'project', 'reference')),

  -- 基础信息
  name            TEXT NOT NULL,           -- 记忆名称
  description     TEXT,                    -- 一句话描述
  content         TEXT NOT NULL,           -- 详细内容

  -- 元数据 (JSON)
  metadata        TEXT DEFAULT '{}',       -- 扩展元数据

  -- 关联 (可选)
  related_paper_id TEXT REFERENCES rc_papers(id) ON DELETE SET NULL,
  related_task_id  TEXT REFERENCES rc_tasks(id) ON DELETE SET NULL,

  -- 时间戳
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  accessed_at     TEXT,                    -- 最后访问时间
  access_count    INTEGER DEFAULT 0,       -- 访问次数

  -- 状态
  is_active       INTEGER DEFAULT 1,       -- 是否激活
  is_private      INTEGER DEFAULT 0        -- 是否隐私 (不注入到上下文)
);

-- 记忆标签表 (多对多)
CREATE TABLE rc_memory_tags (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  color     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rc_memory_tag_links (
  memory_id TEXT NOT NULL REFERENCES rc_memories(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES rc_memory_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, tag_id)
);

-- 记忆引用表 (双向链接)
CREATE TABLE rc_memory_links (
  id        TEXT PRIMARY KEY,
  from_memory_id TEXT NOT NULL REFERENCES rc_memories(id) ON DELETE CASCADE,
  to_memory_id   TEXT NOT NULL REFERENCES rc_memories(id) ON DELETE CASCADE,
  context        TEXT,                    -- 引用上下文
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_memory_id, to_memory_id)
);

-- 记忆访问日志 (分析使用模式)
CREATE TABLE rc_memory_access_log (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES rc_memories(id) ON DELETE CASCADE,
  access_type TEXT NOT NULL,              -- 'search', 'view', 'edit', 'reference'
  context     TEXT,                      -- 访问上下文
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 记忆建议表 (AI 生成)
CREATE TABLE rc_memory_suggestions (
  id              TEXT PRIMARY KEY,
  memory_id       TEXT REFERENCES rc_memories(id) ON DELETE SET NULL, -- NULL 表示新记忆建议
  suggestion_type TEXT NOT NULL,          -- 'new', 'update', 'delete', 'link'
  content         TEXT NOT NULL,
  reason          TEXT NOT NULL,
  confidence      REAL NOT NULL,
  accepted        INTEGER DEFAULT 0,
  rejected        INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 2.2 索引和 FTS5

```sql
-- 性能索引
CREATE INDEX idx_rc_memories_type ON rc_memories(type);
CREATE INDEX idx_rc_memories_active ON rc_memories(is_active);
CREATE INDEX idx_rc_memories_private ON rc_memories(is_private);
CREATE INDEX idx_rc_memories_paper ON rc_memories(related_paper_id);
CREATE INDEX idx_rc_memories_task ON rc_memories(related_task_id);
CREATE INDEX idx_rc_memories_accessed ON rc_memories(accessed_at);
CREATE INDEX idx_rc_memories_access_count ON rc_memories(access_count);

CREATE INDEX idx_rc_memory_tag_links_memory ON rc_memory_tag_links(memory_id);
CREATE INDEX idx_rc_memory_tag_links_tag ON rc_memory_tag_links(tag_id);

CREATE INDEX idx_rc_memory_links_from ON rc_memory_links(from_memory_id);
CREATE INDEX idx_rc_memory_links_to ON rc_memory_links(to_memory_id);

CREATE INDEX idx_rc_memory_access_log_memory ON rc_memory_access_log(memory_id);
CREATE INDEX idx_rc_memory_access_log_created ON rc_memory_access_log(created_at);

CREATE INDEX idx_rc_memory_suggestions_memory ON rc_memory_suggestions(memory_id);
CREATE INDEX idx_rc_memory_suggestions_accepted ON rc_memory_suggestions(accepted);

-- FTS5 全文搜索
CREATE VIRTUAL TABLE rc_memories_fts USING fts5(
  name,
  description,
  content,
  content='rc_memories',
  content_rowid='rowid'
);

-- FTS 同步触发器
CREATE TRIGGER rc_memories_fts_insert AFTER INSERT ON rc_memories BEGIN
  INSERT INTO rc_memories_fts(rowid, name, description, content)
    VALUES (new.rowid, new.name, new.description, new.content);
END;

CREATE TRIGGER rc_memories_fts_update AFTER UPDATE ON rc_memories BEGIN
  INSERT INTO rc_memories_fts(rc_memories_fts, rowid, name, description, content)
    VALUES ('delete', old.rowid, old.name, old.description, old.content);
  INSERT INTO rc_memories_fts(rowid, name, description, content)
    VALUES (new.rowid, new.name, new.description, new.content);
END;

CREATE TRIGGER rc_memories_fts_delete BEFORE DELETE ON rc_memories BEGIN
  INSERT INTO rc_memories_fts(rc_memories_fts, rowid, name, description, content)
    VALUES ('delete', old.rowid, old.name, old.description, old.content);
END;
```

## 三、后端 API 设计

### 3.1 工具 (Tools)

```typescript
// 记忆 CRUD
memory.create(type, name, content, description?, metadata?, options?)
memory.get(id)
memory.update(id, updates)
memory.delete(id)
memory.list(filters?)

// 搜索
memory.search(query, filters?)
memory.getByType(type, filters?)
memory.getByTag(tagName, filters?)
memory.getRecent(limit?)

// 标签管理
memory.createTag(name, color?)
memory.addTag(memoryId, tagName)
memory.removeTag(memoryId, tagName)
memory.listTags()

// 关联管理
memory.linkMemory(fromId, toId, context?)
memory.unlinkMemory(fromId, toId)
memory.getLinks(memoryId, direction?)

// 统计
memory.getStats()
memory.getAccessLog(memoryId, limit?)
memory.getUnusedMemories(thresholdDays?)

// AI 建议
memory.getSuggestions(limit?)
memory.acceptSuggestion(suggestionId)
memory.rejectSuggestion(suggestionId)

// 上下文注入 (类似 claude-mem)
memory.injectContext(query, maxTokens?)  // 获取相关记忆用于注入
```

### 3.2 RPC 接口 (Dashboard)

```typescript
// 记忆管理 RPC
memory.getAll({ filters, pagination }) → Memory[]
memory.getById(id) → MemoryDetail
memory.create(data) → Memory
memory.update(id, data) → Memory
memory.delete(id) → void
memory.search({ query, filters, pagination }) → SearchResult[]
memory.getByType(type, filters?) → Memory[]
memory.getRelated(id) → Memory[]

// 标签 RPC
memory.getTags() → Tag[]
memory.createTag(data) → Tag
memory.updateTag(id, data) → Tag
memory.deleteTag(id) → void

// 关联 RPC
memory.getLinks(id) → MemoryLink[]
memory.createLink(data) → MemoryLink
memory.deleteLink(id) → void

// 统计 RPC
memory.getStats() → MemoryStats
memory.getAccessLog(id, limit?) → AccessLog[]
memory.getUnusedMemories(thresholdDays?) → Memory[]

// 建议 RPC
memory.getSuggestions(limit?) → Suggestion[]
memory.acceptSuggestion(id) → void
memory.rejectSuggestion(id) → void
```

## 四、前端 UI 设计

### 4.1 Dashboard 面板结构

```
Memory Panel (memory-panel/)
├── MemoryList.tsx          # 记忆列表主视图
├── MemoryDetail.tsx        # 记忆详情页
├── MemoryEditor.tsx        # 记忆编辑器
├── MemorySearch.tsx        # 搜索栏
├── TagManager.tsx          # 标签管理
├── StatsView.tsx           # 统计视图
├── SuggestionsPanel.tsx    # AI 建议面板
└── components/
    ├── MemoryCard.tsx      # 记忆卡片
    ├── TypeFilter.tsx      # 类型筛选器
    ├── TagCloud.tsx        # 标签云
    ├── LinkView.tsx        # 关联视图
    └── AccessHistory.tsx   # 访问历史
```

### 4.2 UI 组件设计

#### MemoryCard.tsx
```typescript
interface MemoryCardProps {
  memory: Memory;
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

// 视觉设计
// • 类型图标 + 颜色
// • 名称 + 描述
// • 标签徽章
// • 最后访问时间
// • 访问次数
// • 快捷操作按钮
```

#### TypeFilter.tsx
```typescript
// 类型筛选器 (类似 claude-mem 的类型筛选)
const TYPE_CONFIG = {
  user: { label: '用户', icon: '👤', color: '#3B82F6' },
  feedback: { label: '反馈', icon: '💡', color: '#10B981' },
  project: { label: '项目', icon: '📊', color: '#F59E0B' },
  reference: { label: '引用', icon: '🔗', color: '#8B5CF6' }
};
```

#### MemorySearch.tsx
```typescript
// 搜索栏 (借鉴 claude-mem 的 3 层工作流)
interface SearchState {
  query: string;
  type?: MemoryType;
  tags?: string[];
  sortBy?: 'relevance' | 'created' | 'accessed';
}

// 搜索结果展示
// • 索引模式: 简要信息 (名称、描述、类型)
// • 详情模式: 完整内容
// • 支持实时搜索
```

#### LinkView.tsx
```typescript
// 关联视图 (类似 Notion 的双向链接)
interface LinkViewProps {
  memoryId: string;
  incomingLinks: MemoryLink[];
  outgoingLinks: MemoryLink[];
  onNavigate: (id: string) => void;
}

// 视觉设计
// • 分栏显示: 入链 / 出链
// • 每个链接显示上下文
// • 点击跳转到关联记忆
```

### 4.3 页面布局

```
┌─────────────────────────────────────────────────────────────┐
│  🧠 记忆管理                      [搜索框____________]  🔍   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [全部] [用户] [反馈] [项目] [引用]                           │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 👤 用户记忆                                             │  │
│  │                                                        │  │
│  │ 📌 我是一名数据科学家，专注于机器学习和NLP研究        │  │
│  │    标签: #profile #expertise                           │  │
│  │    最后访问: 2 小时前 | 访问 156 次                   │  │
│  │    [查看] [编辑] [删除]                                │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ 💡 反馈记忆                                             │  │
│  │                                                        │  │
│  │ 📌 偏好简洁的回复风格，不要过多的总结性文字            │  │
│  │    标签: #communication #preference                    │  │
│  │    最后访问: 1 天前 | 访问 42 次                       │  │
│  │    [查看] [编辑] [删除]                                │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ 📊 项目记忆                                             │  │
│  │                                                        │  │
│  │ 📌 论文 "Multi-Agent Reasoning" 截止日期 2026-05-15   │  │
│  │    标签: #deadline #paper-writing                      │  │
│  │    最后访问: 3 小时前 | 访问 89 次                     │  │
│  │    [查看] [编辑] [删除]                                │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  [加载更多...]                                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 五、实现步骤

### Phase 1: 数据库层 (1-2 天)
- [ ] 在 `research-claw-core` 中添加记忆表 schema
- [ ] 实现 FTS5 全文搜索
- [ ] 编写迁移脚本
- [ ] 编写单元测试

### Phase 2: 后端服务 (2-3 天)
- [ ] 实现记忆 CRUD 工具
- [ ] 实现搜索功能
- [ ] 实现标签管理
- [ ] 实现 RPC 接口
- [ ] 编写集成测试

### Phase 3: 前端面板 (3-4 天)
- [ ] 创建 Memory 面板
- [ ] 实现记忆列表
- [ ] 实现搜索功能
- [ ] 实现记忆编辑器
- [ ] 实现标签管理
- [ ] 实现关联视图

### Phase 4: 高级功能 (2-3 天)
- [ ] 实现统计视图
- [ ] 实现访问日志
- [ ] 实现AI建议 (可选)
- [ ] 实现上下文注入

### Phase 5: 集成优化 (1-2 天)
- [ ] 与 rc_papers 集成
- [ ] 与 rc_tasks 集成
- [ ] 添加快捷操作
- [ ] 优化性能

## 六、技术栈

### 后端
- `better-sqlite3` - 数据库 (已存在)
- `TypeScript` - 类型安全 (已存在)
- OpenClaw Plugin SDK - 工具注册 (已存在)

### 前端
- `React 18` - 框架 (已存在)
- `Ant Design 5` - UI 组件 (已存在)
- `Zustand 5` - 状态管理 (已存在)
- `react-markdown` - Markdown 渲染

## 七、与现有系统的对比

### vs Claude Code 原生内存
| 特性 | Claude Code 原生 | Research-Claw Memory |
|------|----------------|---------------------|
| **存储位置** | `~/.claude/projects/*/memory/` | SQLite (统一管理) |
| **管理界面** | 无 | Dashboard 面板 |
| **搜索** | 基础搜索 | FTS5 + 高级筛选 |
| **类型系统** | 4 种类型 | 4 种类型 + 自定义标签 |
| **关联** | 无 | 双向链接 + 文献/任务关联 |
| **统计** | 无 | 访问日志 + 使用分析 |

### vs claude-mem
| 特性 | claude-mem | Research-Claw Memory |
|------|-----------|---------------------|
| **目标场景** | 编程 | 学术研究 |
| **记忆类型** | 观察、会话 | 用户、反馈、项目、引用 |
| **搜索** | MCP 工具 (3 层) | Dashboard UI |
| **存储** | SQLite + Chroma | SQLite (FTS5) |
| **集成** | Claude Code CLI | OpenClaw + Dashboard |
| **Web UI** | 独立服务 (37777) | Dashboard 集成 |

## 八、使用场景示例

### 场景 1: 记录写作偏好
```
用户: 记住我偏好 APA 格式的引用风格，不要用数字引用

系统: 自动创建 feedback 类型的记忆
{
  type: 'feedback',
  name: '引用格式偏好',
  description: '学术论文引用格式',
  content: '用户偏好 APA 格式的引用风格，不要用数字引用 (如 [1])。'
}

后续: 生成论文时自动引用该记忆
```

### 场景 2: 项目截止日期
```
用户: 我的论文截止日期是 5 月 15 日

系统: 自动创建 project 类型的记忆
{
  type: 'project',
  name: '论文截止日期',
  description: 'Multi-Agent Reasoning 论文',
  content: '论文 "Multi-Agent Reasoning" 截止日期是 2026-05-15。',
  related_paper_id: 'paper-xxx'
}

后续: 在任务管理、实验规划时自动提醒
```

### 场景 3: 实验参数记录
```
用户: 记住这个实验用 batch_size=32, learning_rate=0.001

系统: 自动创建 project 类型的记忆
{
  type: 'project',
  name: '实验参数',
  description: 'MLP baseline 配置',
  content: 'batch_size=32, learning_rate=0.001, epochs=100'
}

后续: 复现实验时自动使用这些参数
```

## 九、未来扩展

### 短期 (1-2 个月)
- [ ] AI 自动提取记忆 (从对话中)
- [ ] 记忆版本历史
- [ ] 记忆导入/导出
- [ ] 记忆分享 (团队协作)

### 中期 (3-6 个月)
- [ ] 语义搜索 (向量嵌入)
- [ ] 记忆聚类分析
- [ ] 记忆推荐系统
- [ ] 与 Notion/Obsidian 同步

### 长期 (6 个月+)
- [ ] 多模态记忆 (图片、视频)
- [ ] 知识图谱构建
- [ ] 跨项目记忆共享
- [ ] 记忆市场 (社区分享)
