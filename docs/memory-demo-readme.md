# Research-Claw 记忆管理插件 Demo

这是一个记忆管理插件的演示实现，展示了核心功能。

## 📦 已实现的功能

### 后端 (extensions/research-claw-core/src/memory/)

1. **数据库层** (`src/db/schema.ts`)
   - ✅ 记忆表 (rc_memories)
   - ✅ 标签表 (rc_memory_tags, rc_memory_tag_links)
   - ✅ 关联表 (rc_memory_links)
   - ✅ FTS5 全文搜索索引

2. **服务层** (`src/memory/service.ts`)
   - ✅ MemoryService 类
   - ✅ CRUD 操作
   - ✅ 搜索功能 (FTS5)
   - ✅ 标签管理
   - ✅ 关联管理
   - ✅ 统计功能
   - ✅ 示例数据

3. **工具层** (`src/memory/tools.ts`)
   - ✅ 11 个 Agent 工具
   - ✅ 创建、读取、更新、删除
   - ✅ 搜索和列表
   - ✅ 标签和关联管理
   - ✅ 统计查询

4. **RPC 层** (`src/memory/rpc.ts`)
   - ✅ 17 个 RPC 方法
   - ✅ 完整的参数验证
   - ✅ 错误处理

### 前端 (dashboard/src/)

1. **状态管理** (`src/stores/memory.ts`)
   - ✅ Zustand store
   - ✅ 完整的 CRUD 操作
   - ✅ 搜索和筛选
   - ✅ 标签管理

2. **UI 组件** (`src/components/panels/MemoryPanel.tsx`)
   - ✅ 记忆列表
   - ✅ 搜索栏
   - ✅ 类型筛选
   - ✅ 创建/编辑/删除
   - ✅ 详情查看
   - ✅ 标签管理
   - ✅ 统计面板

## 🚀 如何运行 Demo

### 1. 构建后端

```bash
cd /Users/synliu/research-claw/extensions/research-claw-core
pnpm build
```

### 2. 构建前端

```bash
cd /Users/synliu/research-claw/dashboard
pnpm build
```

### 3. 启动服务

```bash
cd /Users/synliu/research-claw
pnpm serve
```

### 4. 访问 Dashboard

打开浏览器访问 `http://127.0.0.1:28789`

## 📝 使用示例

### 通过对话使用工具

```
你：帮我创建一个记忆，记录我的论文截止日期

系统：使用 memory_create 工具创建记忆
```

```
你：搜索关于"论文"的记忆

系统：使用 memory_search 工具搜索
```

```
你：查看记忆统计

系统：使用 memory_stats 工具获取统计信息
```

### 通过 Dashboard 使用

1. 在左侧导航栏找到 "记忆管理" 面板
2. 点击 "新建记忆" 创建记忆
3. 使用搜索栏搜索记忆
4. 点击记忆卡片查看详情
5. 在详情中添加/删除标签
6. 点击 "详细统计" 查看使用情况

## 🎨 界面预览

### 主界面
- 顶部：统计卡片（总数、活跃、隐私、详细统计）
- 中部：搜索和筛选栏
- 底部：记忆列表（卡片形式）

### 记忆卡片
- 类型图标 + 名称
- 描述（如果有）
- 标签
- 最后访问时间和访问次数
- 操作按钮（查看、编辑、删除）

### 详情弹窗
- 完整内容显示
- 标签管理（添加/删除）
- 元信息（创建/更新/访问时间）

## 🔧 技术细节

### 数据库 Schema

```sql
-- 主表
rc_memories (id, type, name, description, content, ...)
rc_memory_tags (id, name, color, ...)
rc_memory_tag_links (memory_id, tag_id, ...)
rc_memory_links (from_memory_id, to_memory_id, context, ...)

-- FTS5 全文搜索
rc_memories_fts (name, description, content)
```

### API 端点

#### RPC 方法
- `rc.memory.list` - 列表
- `rc.memory.get` - 获取详情
- `rc.memory.create` - 创建
- `rc.memory.update` - 更新
- `rc.memory.delete` - 删除
- `rc.memory.search` - 搜索
- `rc.memory.getByType` - 按类型获取
- `rc.memory.getRecent` - 最近访问
- `rc.memory.tags.*` - 标签管理
- `rc.memory.links.*` - 关联管理
- `rc.memory.stats.get` - 统计

#### Agent 工具
- `memory_create` - 创建记忆
- `memory_get` - 获取记忆
- `memory_update` - 更新记忆
- `memory_delete` - 删除记忆
- `memory_list` - 列表
- `memory_search` - 搜索
- `memory_add_tag` - 添加标签
- `memory_remove_tag` - 删除标签
- `memory_link` - 创建关联
- `memory_unlink` - 删除关联
- `memory_stats` - 获取统计

## 📊 示例数据

Service 中包含 5 条示例数据：
1. 用户背景 - 数据科学家，专注 ML/NLP
2. 沟通偏好 - 偏好简洁回复
3. 论文截止日期 - Multi-Agent Reasoning
4. 实验参数配置 - MLP baseline
5. Grafana 仪表盘 - API 延迟监控

## 🚧 待完成功能

- [ ] 与 rc_papers 自动同步
- [ ] 与 rc_tasks 自动同步
- [ ] AI 自动提取记忆
- [ ] 记忆版本历史
- [ ] 导入/导出功能
- [ ] 记忆分享功能
- [ ] 语义搜索（向量嵌入）
- [ ] 记忆图谱可视化
- [ ] 与 Notion/Obsidian 同步

## 📚 相关文档

- [完整设计文档](./memory-plugin-design.md)
- [知识图谱设计](./knowledge-graph-plugin.md)

## 🤝 贡献

这是一个 demo，欢迎提出改进建议！

## 📄 许可证

与 Research-Claw 主项目保持一致
