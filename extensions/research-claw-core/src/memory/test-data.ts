/**
 * Test Data Generator for Memory System
 *
 * Generates sample sessions and memories for testing the MemoryPanel.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.research-claw', 'library.db');

// Sample data templates
const SAMPLE_SESSIONS = [
  {
    events_count: 25,
    memories_extracted: 4,
    duration_hours: 1.5,
  },
  {
    events_count: 18,
    memories_extracted: 3,
    duration_hours: 0.8,
  },
  {
    events_count: 42,
    memories_extracted: 6,
    duration_hours: 2.3,
  },
  {
    events_count: 12,
    memories_extracted: 2,
    duration_hours: 0.5,
  },
  {
    events_count: 35,
    memories_extracted: 5,
    duration_hours: 1.8,
  },
];

const SAMPLE_MEMORIES = [
  {
    type: 'user' as const,
    name: '偏好使用中文进行交流',
    description: '用户在对话中表现出对中文的强烈偏好',
    content: '用户在所有对话中都使用中文，并且对中文的回复更加满意。在涉及技术术语时，用户能够理解中英文混合的表达方式。',
    tags: ['语言偏好', '交流方式'],
  },
  {
    type: 'user' as const,
    name: '熟悉 React 和 TypeScript',
    description: '用户对前端技术栈有深入的了解',
    content: '用户在讨论代码时经常提到 React 和 TypeScript，对这两个技术的概念和最佳实践都很熟悉。能够理解复杂的类型定义和组件架构。',
    tags: ['技术栈', '前端'],
  },
  {
    type: 'user' as const,
    name: '喜欢简洁的代码风格',
    description: '用户偏好清晰、简洁的代码实现',
    content: '用户在代码审查中多次强调代码的可读性和简洁性，不喜欢过度复杂的抽象和冗余的代码。倾向于使用函数式编程风格。',
    tags: ['代码风格', '编程习惯'],
  },
  {
    type: 'feedback' as const,
    name: '希望增加更多示例代码',
    description: '用户反馈需要更多实际可运行的代码示例',
    content: '用户表示在解释概念时，提供完整的、可运行的代码示例会更有帮助。抽象的解释虽然有用，但具体的使用场景更重要。',
    tags: ['改进建议', '文档'],
  },
  {
    type: 'feedback' as const,
    name: '界面响应速度需要优化',
    description: '用户反馈某些操作的响应时间较长',
    content: '用户提到在加载大量数据时，界面会有明显的卡顿。建议添加加载状态指示器和分页功能来改善用户体验。',
    tags: ['性能', '用户体验'],
  },
  {
    type: 'feedback' as const,
    name: '搜索功能需要更智能',
    description: '用户希望搜索能理解语义而非仅匹配关键词',
    content: '当前的搜索功能只能匹配精确的关键词，用户希望能够根据语义进行模糊搜索，即使没有完全匹配的关键词也能找到相关内容。',
    tags: ['搜索', '功能改进'],
  },
  {
    type: 'project' as const,
    name: '研究-claw 记忆系统',
    description: '正在为 Research-Claw 开发自动记忆提取功能',
    content: '项目目标是实现类似 claude-mem 的自动记忆系统，能够监控对话会话，自动提取重要的信息并存储为记忆。需要支持多种记忆类型：用户偏好、反馈、项目信息和外部引用。',
    tags: ['当前项目', '记忆系统'],
  },
  {
    type: 'project' as const,
    name: '卡片式 UI 设计',
    description: '正在重新设计记忆面板的界面',
    content: '采用卡片式布局来展示记忆，每个卡片包含类型标签、标题、内容预览和元数据。支持按会话过滤和按类型筛选。设计灵感来自 Notion 和 claude-mem。',
    tags: ['UI设计', '前端开发'],
  },
  {
    type: 'project' as const,
    name: '数据库迁移到 v12',
    description: '添加会话监控功能需要新的数据库表',
    content: '需要创建 rc_sessions 和 rc_session_events 表来跟踪对话会话。同时添加相应的索引以优化查询性能。迁移脚本已经准备好，需要进行测试。',
    tags: ['数据库', '迁移'],
  },
  {
    type: 'project' as const,
    name: 'TypeScript 类型定义',
    description: '完善记忆系统的类型系统',
    content: '为记忆、会话、事件等核心概念定义了完整的 TypeScript 接口。包括 MemoryType、SessionEventType、MemoryExtractionConfig 等。类型系统帮助在开发阶段捕获错误。',
    tags: ['TypeScript', '类型系统'],
  },
  {
    type: 'reference' as const,
    name: 'claude-mem GitHub 仓库',
    description: 'claude-mem 项目的 GitHub 仓库',
    content: 'https://github.com/thedotmack/claude-mem - 一个 Claude Code 插件，自动捕获 Claude 在编码会话中所做的一切，使用 AI（通过 Claude 的 agent-sdk）压缩，并将相关上下文注入到未来的会话中。',
    tags: ['GitHub', '参考项目'],
  },
  {
    type: 'reference' as const,
    name: 'Notion 卡片式设计',
    description: 'Notion 的卡片式布局设计理念',
    content: 'Notion 使用卡片式布局来展示各种类型的内容，每个卡片都有统一的视觉风格但可以根据内容类型进行定制。这种设计既保持了界面的一致性，又允许内容的多样性。',
    tags: ['设计参考', 'Notion'],
  },
  {
    type: 'reference' as const,
    name: 'Zustand 状态管理',
    description: 'Zustand 是一个轻量级的 React 状态管理库',
    content: 'Zustand 提供了简洁的 API，无需使用 Context Provider 或 reducer。它支持 TypeScript、中间件、持久化等高级功能。在 Research-Claw 项目中用于管理 UI 状态和记忆数据。',
    tags: ['技术文档', '状态管理'],
  },
  {
    type: 'reference' as const,
    name: 'Ant Design 组件库',
    description: '企业级 UI 设计语言和 React 组件库',
    content: 'Ant Design 提供了丰富的高质量组件，包括表格、表单、卡片、标签等。具有完善的 TypeScript 支持、主题定制能力和国际化功能。是 Research-Claw Dashboard 的主要 UI 框架。',
    tags: ['技术文档', 'UI组件'],
  },
];

const TAG_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1',
];

function generateTimestamp(offsetHours: number): string {
  const date = new Date(Date.now() - offsetHours * 3600000);
  return date.toISOString();
}

function generateTagColor(): string {
  return TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
}

export function generateTestData(dbPath: string = DEFAULT_DB_PATH): void {
  console.log(`📊 Generating test data for: ${dbPath}`);

  const db = new Database(dbPath);
  db.pragma('journal_mode = ' + 'WAL');

  try {
    // Generate sessions
    console.log('📝 Generating sessions...');
    const sessionIds: string[] = [];
    const sessionMetadata: Record<string, { index: number }> = {};

    SAMPLE_SESSIONS.forEach((sessionData, index) => {
      const sessionId = randomUUID();
      const startedAt = generateTimestamp(index * 3 + Math.random() * 2);
      const durationMs = sessionData.duration_hours * 3600000;
      const endedAt = new Date(new Date(startedAt).getTime() + durationMs).toISOString();

      // Insert session
      db.prepare(`
        INSERT INTO rc_sessions (id, started_at, ended_at, events_count, memories_extracted, metadata)
        VALUES (?, ?, ?, ?, ?, '{}')
      `).run(sessionId, startedAt, endedAt, sessionData.events_count, sessionData.memories_extracted);

      // Generate session events
      const eventTypes = ['session_start', 'user_prompt', 'tool_use', 'assistant_response', 'session_end'];
      let eventCount = 0;

      // Session start
      db.prepare(`
        INSERT INTO rc_session_events (id, session_id, event_type, timestamp, data)
        VALUES (?, ?, 'session_start', ?, '{}')
      `).run(randomUUID(), sessionId, startedAt);

      // Generate random events in between
      const interval = (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / sessionData.events_count;
      for (let i = 1; i < sessionData.events_count - 1; i++) {
        const eventType = eventTypes[Math.floor(Math.random() * (eventTypes.length - 2)) + 1];
        const eventTimestamp = new Date(new Date(startedAt).getTime() + i * interval).toISOString();
        const eventData = eventType === 'tool_use'
          ? JSON.stringify({ tool_name: 'example_tool', parameters: {}, result: {} })
          : JSON.stringify({ content: 'Sample event content' });

        db.prepare(`
          INSERT INTO rc_session_events (id, session_id, event_type, timestamp, data)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), sessionId, eventType, eventTimestamp, eventData);
        eventCount++;
      }

      // Session end
      db.prepare(`
        INSERT INTO rc_session_events (id, session_id, event_type, timestamp, data)
        VALUES (?, ?, 'session_end', ?, '{}')
      `).run(randomUUID(), sessionId, endedAt);

      sessionIds.push(sessionId);
      sessionMetadata[sessionId] = { index };
      console.log(`  ✓ Session ${index + 1}: ${sessionData.events_count} events, ${sessionData.memories_extracted} memories`);
    });

    // Generate tags
    console.log('🏷️  Generating tags...');
    const allTags = new Set<string>();
    SAMPLE_MEMORIES.forEach(mem => {
      if (mem.tags) {
        mem.tags.forEach(tag => allTags.add(tag));
      }
    });

    const tagIds: Record<string, string> = {};
    allTags.forEach(tagName => {
      const tagId = randomUUID();
      db.prepare(`
        INSERT INTO rc_memory_tags (id, name, color, created_at)
        VALUES (?, ?, ?, datetime('now'))
      `).run(tagId, tagName, generateTagColor());
      tagIds[tagName] = tagId;
      console.log(`  ✓ Tag: ${tagName}`);
    });

    // Generate memories
    console.log('💾 Generating memories...');
    let memoryIndex = 0;
    const memoriesPerSession = Math.ceil(SAMPLE_MEMORIES.length / sessionIds.length);

    SAMPLE_MEMORIES.forEach((memData) => {
      const memoryId = randomUUID();
      const sessionId = sessionIds[Math.floor(memoryIndex / memoriesPerSession) % sessionIds.length];
      const sessionMeta = sessionMetadata[sessionId];

      const createdAt = generateTimestamp(sessionMeta.index * 3 + Math.random() * 2);
      const accessedAt = generateTimestamp(Math.random() * 2);

      // Insert memory
      db.prepare(`
        INSERT INTO rc_memories (
          id, type, name, description, content, metadata,
          related_paper_id, related_task_id,
          created_at, updated_at, accessed_at, access_count,
          is_active, is_private
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 1, 0)
      `).run(
        memoryId,
        memData.type,
        memData.name,
        memData.description,
        memData.content,
        JSON.stringify({ session_id: sessionId }),
        createdAt,
        createdAt,
        accessedAt,
        Math.floor(Math.random() * 20) + 1,
      );

      // Link memory to tags
      if (memData.tags) {
        memData.tags.forEach(tagName => {
          const tagId = tagIds[tagName];
          if (tagId) {
            db.prepare(`
              INSERT INTO rc_memory_tag_links (memory_id, tag_id)
              VALUES (?, ?)
            `).run(memoryId, tagId);
          }
        });
      }

      memoryIndex++;
      console.log(`  ✓ Memory ${memoryIndex}: ${memData.name} (${memData.type})`);
    });

    // Update session memories_extracted count
    const actualMemoriesPerSession = Math.ceil(SAMPLE_MEMORIES.length / sessionIds.length);
    sessionIds.forEach((sessionId, index) => {
      const memoriesExtracted = index === sessionIds.length - 1
        ? SAMPLE_MEMORIES.length - (sessionIds.length - 1) * actualMemoriesPerSession
        : actualMemoriesPerSession;

      db.prepare(`
        UPDATE rc_sessions
        SET memories_extracted = ?
        WHERE id = ?
      `).run(memoriesExtracted, sessionId);
    });

    // Verify data
    const sessionCount = db.prepare('SELECT COUNT(*) as count FROM rc_sessions').get() as { count: number };
    const memoryCount = db.prepare('SELECT COUNT(*) as count FROM rc_memories').get() as { count: number };
    const tagCount = db.prepare('SELECT COUNT(*) as count FROM rc_memory_tags').get() as { count: number };
    const eventCount = db.prepare('SELECT COUNT(*) as count FROM rc_session_events').get() as { count: number };

    console.log('\n✅ Test data generated successfully!');
    console.log(`   Sessions: ${sessionCount.count}`);
    console.log(`   Memories: ${memoryCount.count}`);
    console.log(`   Tags: ${tagCount.count}`);
    console.log(`   Events: ${eventCount.count}`);
    console.log('\n📝 Sample queries:');
    console.log(`   SELECT * FROM rc_sessions ORDER BY started_at DESC;`);
    console.log(`   SELECT * FROM rc_memories ORDER BY created_at DESC;`);
    console.log(`   SELECT * FROM rc_session_events WHERE session_id = '${sessionIds[0]}' ORDER BY timestamp;`);

  } catch (error) {
    console.error('❌ Error generating test data:', error);
    throw error;
  } finally {
    db.close();
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] || DEFAULT_DB_PATH;
  generateTestData(dbPath);
}
