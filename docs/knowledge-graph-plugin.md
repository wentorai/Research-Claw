# Research-Claw 知识关联插件架构设计

> 融合 Claude Code 内存系统 + Notion 知识图谱

## 一、设计理念

### 1.1 核心概念

```
┌─────────────────────────────────────────────────────────────────┐
│                    Knowledge Graph Layer                        │
├─────────────────────────────────────────────────────────────────┤
│  Nodes (知识节点)          Relations (关系)                     │
│  ├── Paper (论文)          ├── cites (引用)                      │
│  ├── Note (笔记)           ├── mentions (提及)                   │
│  ├── Task (任务)           ├── related_to (相关)                │
│  ├── Code (代码)           ├── depends_on (依赖)                │
│  ├── Concept (概念)        ├── contains (包含)                  │
│  └── Memory (记忆)         └── derives_from (衍生)              │
│                                                                 │
│  Features:                                                      │
│  • Bi-directional links [[node-id]]                             │
│  • AI-powered auto-connection                                   │
│  • Interactive graph visualization                              │
│  • Semantic search with FTS5                                    │
│  • Persistent memory (user/feedback/project/reference)          │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 与现有系统的集成

```
Research-Claw Ecosystem
│
├── rc_papers ──────────────────────────────┐
├── rc_tasks  ─────────────────────┐        │
├── workspace/ ──────────────┐     │        │
│                              │     │        │
│   Knowledge Graph Plugin ─────┼─────┼────────┤
│   • ext-knowledge-graph/      │     │        │
│     ├── db/                  │     │        │
│     ├── src/                 │     │        │
│     └── dashboard/           │     │        │
│                                    │        │
└────────────────────────────────────┴────────┘
```

## 二、数据库模式设计

### 2.1 核心表结构

```sql
-- 知识节点表
CREATE TABLE kg_nodes (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,  -- paper, note, task, code, concept, memory
  title           TEXT NOT NULL,
  content         TEXT,
  source_id       TEXT,          -- 关联到 rc_papers.id, rc_tasks.id 等
  source_type     TEXT,          -- 'rc_paper', 'rc_task', 'workspace_file'
  metadata        TEXT DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  embedding       BLOB,          -- 向量嵌入 (未来扩展)
  embedding_model TEXT           -- 使用的嵌入模型
);

-- 关系表
CREATE TABLE kg_relations (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  target_id       TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL,  -- cites, mentions, related_to, depends_on, contains, derives_from
  strength        REAL DEFAULT 1.0,  -- 关系强度 (0-1)
  confidence      REAL DEFAULT 1.0,  -- AI 置信度
  context         TEXT,          -- 关系上下文
  created_by      TEXT DEFAULT 'auto',  -- 'user', 'auto', 'ai'
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 记忆表 (Claude Code 风格)
CREATE TABLE kg_memories (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,  -- user, feedback, project, reference
  name            TEXT NOT NULL,
  description     TEXT,
  content         TEXT NOT NULL,
  metadata        TEXT DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 双向链接引用表 (类似 Notion 的 [[link]] 语法)
CREATE TABLE kg_backlinks (
  id              TEXT PRIMARY KEY,
  from_node_id    TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  to_node_id      TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  context         TEXT,          -- 引用上下文
  position        INTEGER,       -- 在文本中的位置
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_node_id, to_node_id, position)
);

-- AI 建议表
CREATE TABLE kg_suggestions (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  target_id       TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL,
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
CREATE INDEX idx_kg_nodes_type ON kg_nodes(type);
CREATE INDEX idx_kg_nodes_source ON kg_nodes(source_type, source_id);
CREATE INDEX idx_kg_relations_source ON kg_relations(source_id);
CREATE INDEX idx_kg_relations_target ON kg_relations(target_id);
CREATE INDEX idx_kg_relations_type ON kg_relations(relation_type);
CREATE INDEX idx_kg_memories_type ON kg_memories(type);
CREATE INDEX idx_kg_backlinks_from ON kg_backlinks(from_node_id);
CREATE INDEX idx_kg_backlinks_to ON kg_backlinks(to_node_id);
CREATE INDEX idx_kg_suggestions_source ON kg_suggestions(source_id);
CREATE INDEX idx_kg_suggestions_accepted ON kg_suggestions(accepted);

-- FTS5 全文搜索
CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(
  title,
  content,
  content_rowid='rowid',
  content='kg_nodes'
);

-- FTS 同步触发器
CREATE TRIGGER kg_nodes_fts_insert AFTER INSERT ON kg_nodes BEGIN
  INSERT INTO kg_nodes_fts(rowid, title, content)
    VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER kg_nodes_fts_update AFTER UPDATE ON kg_nodes BEGIN
  INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO kg_nodes_fts(rowid, title, content)
    VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER kg_nodes_fts_delete BEFORE DELETE ON kg_nodes BEGIN
  INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.title, old.content);
END;
```

## 三、后端 API 设计

### 3.1 工具 (Tools)

```typescript
// 知识节点管理
kg.createNode(type, title, content, sourceId?, sourceType?)
kg.getNode(id)
kg.updateNode(id, updates)
kg.deleteNode(id)
kg.listNodes(filters?)

// 关系管理
kg.createRelation(sourceId, targetId, type, context?)
kg.getRelations(nodeId, direction?)
kg.updateRelation(id, updates)
kg.deleteRelation(id)

// 记忆系统 (Claude Code 风格)
kg.saveMemory(type, name, content, description?, metadata?)
kg.getMemory(type, name)
kg.listMemories(type?)
kg.searchMemories(query)
kg.updateMemory(id, updates)
kg.deleteMemory(id)

// 双向链接
kg.parseWikiLinks(content)  // 解析 [[link]] 语法
kg.getBacklinks(nodeId)
kg.updateBacklinks(nodeId, content)

// AI 关联
kg.suggestConnections(nodeId, limit?)
kg.acceptSuggestion(suggestionId)
kg.rejectSuggestion(suggestionId)

// 图谱查询
kg.getGraph(filters?)  // 获取子图
kg.getShortestPath(fromId, toId)
kg.getNeighbors(nodeId, depth?)
kg.getConnectedComponents()

// 搜索
kg.searchNodes(query, filters?)
kg.semanticSearch(query, limit?)  // 语义搜索 (未来)
```

### 3.2 RPC 接口

```typescript
// Dashboard RPC 方法
knowledgeGraph.getGraph({ filters, layout }) → GraphData
knowledgeGraph.getNodeDetail(id) → NodeDetail
knowledgeGraph.getRelations(id, direction) → Relation[]
knowledgeGraph.getBacklinks(id) → Backlink[]
knowledgeGraph.createNode(data) → Node
knowledgeGraph.updateNode(id, data) → Node
knowledgeGraph.deleteNode(id) → void
knowledgeGraph.createRelation(data) → Relation
knowledgeGraph.deleteRelation(id) → void
knowledgeGraph.getSuggestions(nodeId) → Suggestion[]
knowledgeGraph.acceptSuggestion(id) → void
knowledgeGraph.rejectSuggestion(id) → void

// Memory RPC 方法
memory.getAll() → Memory[]
memory.getByType(type) → Memory[]
memory.getByName(type, name) → Memory | null
memory.create(data) → Memory
memory.update(id, data) → Memory
memory.delete(id) → void
memory.search(query) → Memory[]
```

## 四、前端组件设计

### 4.1 Dashboard 面板

```
Knowledge Graph Panel (kg-panel/)
├── GraphView.tsx           # 图谱可视化主视图
├── NodeDetail.tsx          # 节点详情
├── RelationEditor.tsx      # 关系编辑器
├── MemoryManager.tsx       # 记忆管理
├── SuggestionsPanel.tsx    # AI 建议面板
└── SearchBar.tsx           # 搜索栏
```

### 4.2 可视化库选择

**推荐**: `react-force-graph-2d` 或 `vis-network`

```typescript
// GraphView.tsx 示例结构
interface GraphData {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    data: any;
  }>;
  links: Array<{
    source: string;
    target: string;
    type: string;
    label: string;
  }>;
}

// 节点颜色映射
const NODE_COLORS = {
  paper: '#3B82F6',
  note: '#10B981',
  task: '#F59E0B',
  code: '#8B5CF6',
  concept: '#EF4444',
  memory: '#EC4899'
};

// 关系类型映射
const RELATION_TYPES = {
  cites: { label: '引用', color: '#94A3B8', dashed: false },
  mentions: { label: '提及', color: '#CBD5E1', dashed: true },
  related_to: { label: '相关', color: '#64748B', dashed: true },
  depends_on: { label: '依赖', color: '#F59E0B', dashed: false },
  contains: { label: '包含', color: '#10B981', dashed: false },
  derives_from: { label: '衍生', color: '#8B5CF6', dashed: false }
};
```

### 4.3 双向链接语法支持

```typescript
// WikiLinkParser.ts
interface ParsedLink {
  text: string;
  nodeId?: string;
  position: number;
}

// 解析 [[node-id]] 或 [[node-id|display-text]]
function parseWikiLinks(content: string): ParsedLink[] {
  const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const matches: ParsedLink[] = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    matches.push({
      text: match[0],
      nodeId: match[1],
      position: match.index
    });
  }

  return matches;
}

// 渲染器组件
function WikiLinkRenderer({ content }: { content: string }) {
  const links = parseWikiLinks(content);
  const parts = content.split(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);

  return (
    <span>
      {parts.map((part, i) => {
        const link = links[i];
        if (link?.nodeId) {
          return (
            <Link
              key={i}
              to={`/graph/node/${link.nodeId}`}
              className="wiki-link"
            >
              {link.text}
            </Link>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}
```

## 五、与现有系统集成

### 5.1 自动同步机制

```typescript
// 当论文被添加时自动创建节点
onPaperAdded(paper: Paper) {
  kg.createNode('paper', paper.title, paper.abstract, paper.id, 'rc_paper');
}

// 当任务被创建时自动创建节点
onTaskCreated(task: Task) {
  kg.createNode('task', task.title, task.description, task.id, 'rc_task');
}

// 当工作区文件被修改时扫描 wiki links
onWorkspaceFileChanged(filePath: string, content: string) {
  const links = parseWikiLinks(content);
  const fileId = `file:${filePath}`;

  // 创建或更新文件节点
  kg.createNode('code', filePath, content, fileId, 'workspace_file');

  // 更新双向链接
  links.forEach(link => {
    if (link.nodeId) {
      kg.createBacklink(fileId, link.nodeId, content.substring(link.position, link.position + 50));
    }
  });
}
```

### 5.2 AI 驱动的关联建议

```typescript
// 基于语义相似性建议关联
async function suggestSemanticConnections(nodeId: string, limit: number = 5) {
  const node = await kg.getNode(nodeId);
  const allNodes = await kg.listNodes({ type: node.type });

  // 使用 LLM 计算相似度
  const similarities = await Promise.all(
    allNodes
      .filter(n => n.id !== nodeId)
      .map(async (other) => ({
        nodeId: other.id,
        similarity: await computeSimilarity(node.content, other.content)
      }))
  );

  return similarities
    .filter(s => s.similarity > 0.7)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

// 基于内容关键词建议关联
async function suggestKeywordConnections(nodeId: string) {
  const node = await kg.getNode(nodeId);
  const keywords = extractKeywords(node.content);

  const candidates = await kg.searchNodes(
    keywords.join(' '),
    { excludeId: nodeId }
  );

  return candidates.map(c => ({
    targetId: c.id,
    relationType: 'related_to',
    reason: `共享关键词: ${keywords.join(', ')}`,
    confidence: 0.8
  }));
}
```

## 六、实现步骤

### Phase 1: 基础架构 (Week 1)
- [ ] 创建 `extensions/knowledge-graph/` 目录
- [ ] 实现数据库 schema 和迁移
- [ ] 实现基础的 CRUD 工具
- [ ] 实现 RPC 接口

### Phase 2: 核心功能 (Week 2)
- [ ] 实现节点和关系管理
- [ ] 实现记忆系统 (Claude Code 风格)
- [ ] 实现双向链接解析
- [ ] 实现 FTS 全文搜索

### Phase 3: 前端面板 (Week 3)
- [ ] 创建 Dashboard Knowledge Graph 面板
- [ ] 实现图谱可视化组件
- [ ] 实现节点详情和关系编辑器
- [ ] 实现记忆管理界面

### Phase 4: AI 集成 (Week 4)
- [ ] 实现自动关联建议
- [ ] 实现语义搜索 (可选)
- [ ] 实现智能聚类

### Phase 5: 系统集成 (Week 5)
- [ ] 与 rc_papers 同步
- [ ] 与 rc_tasks 同步
- [ ] 与 workspace 文件同步
- [ ] 实现自动化触发器

## 七、技术栈

### 后端
- `better-sqlite3` - 数据库
- `TypeScript` - 类型安全
- OpenClaw Plugin SDK - 工具注册

### 前端
- `react-force-graph-2d` - 图谱可视化
- `react-flow` - 流程图 (备选)
- `vis-network` - 网络图 (备选)
- `Ant Design` - UI 组件
- `Zustand` - 状态管理

### AI (未来)
- `openai` 或 `@anthropic-ai/sdk` - 语义嵌入
- 向量数据库 (Qdrant/Chroma) - 可选
