/**
 * Realistic RPC response fixtures for store parity tests.
 *
 * These payloads mirror the EXACT shapes returned by the Research-Claw Core plugin:
 *   - Literature: extensions/research-claw-core/src/literature/service.ts (Paper interface, lines 50-71)
 *   - Literature RPC: extensions/research-claw-core/src/literature/rpc.ts (rc.lit.list wraps service.list, line 137)
 *   - Tasks: extensions/research-claw-core/src/tasks/service.ts (Task interface, lines 25-41)
 *   - Tasks RPC: extensions/research-claw-core/src/tasks/rpc.ts (rc.task.list returns service.list, line 182)
 *   - Sessions: OpenClaw gateway sessions.list (src/gateway/session-utils.types.ts, line 21)
 *
 * Each fixture is annotated with the source file and line that defines its shape.
 */

// ── rc.lit.list response ─────────────────────────────────────────────────
// Source: literature/rpc.ts:137 → { ...service.list(), offset, limit }
// service.list() returns { items: Paper[], total: number }
// Paper shape: literature/service.ts:50-71

export const RC_LIT_LIST_RESPONSE = {
  items: [
    {
      id: '019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit'],
      abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
      doi: '10.48550/arXiv.1706.03762',
      url: 'https://arxiv.org/abs/1706.03762',
      arxiv_id: '1706.03762',
      pdf_path: '/papers/attention-is-all-you-need.pdf',
      source: 'arxiv',
      source_id: '1706.03762',
      venue: 'NeurIPS 2017',
      year: 2017,
      added_at: '2026-03-10T08:30:00.000Z',
      updated_at: '2026-03-12T14:22:00.000Z',
      read_status: 'read' as const,
      rating: 5,
      notes: 'Foundational transformer paper. Key insight: self-attention replaces recurrence.',
      bibtex_key: 'vaswani2017attention',
      metadata: { impact_factor: 'high', cited_by_count: 120000 },
      tags: ['transformers', 'NLP', 'deep-learning'],
    },
    {
      id: '019523a4-8c3d-7e00-9e4f-2b3c4d5e6f7a',
      title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
      authors: ['Jacob Devlin', 'Ming-Wei Chang', 'Kenton Lee', 'Kristina Toutanova'],
      abstract: 'We introduce a new language representation model called BERT.',
      doi: '10.18653/v1/N19-1423',
      url: 'https://arxiv.org/abs/1810.04805',
      arxiv_id: '1810.04805',
      pdf_path: null,
      source: 'arxiv',
      source_id: '1810.04805',
      venue: 'NAACL 2019',
      year: 2019,
      added_at: '2026-03-11T10:15:00.000Z',
      updated_at: '2026-03-11T10:15:00.000Z',
      read_status: 'reading' as const,
      rating: null,
      notes: null,
      bibtex_key: 'devlin2019bert',
      metadata: {},
      tags: ['NLP', 'pre-training'],
    },
    {
      id: '019523a4-9d4e-7e00-af5f-3c4d5e6f7a8b',
      title: 'Scaling Laws for Neural Language Models',
      authors: ['Jared Kaplan', 'Sam McCandlish', 'Tom Henighan'],
      abstract: null,
      doi: null,
      url: 'https://arxiv.org/abs/2001.08361',
      arxiv_id: '2001.08361',
      pdf_path: null,
      source: 'arxiv',
      source_id: '2001.08361',
      venue: null,
      year: 2020,
      added_at: '2026-03-12T09:00:00.000Z',
      updated_at: '2026-03-12T09:00:00.000Z',
      read_status: 'unread' as const,
      rating: null,
      notes: null,
      bibtex_key: null,
      metadata: {},
      tags: [],
    },
  ],
  total: 3,
  offset: 0,
  limit: 50,
};

// ── rc.lit.search response ───────────────────────────────────────────────
// Source: literature/rpc.ts:366-375 → service.search() returns { items: Paper[], total: number }
// Same Paper shape, but no offset/limit wrapper from the RPC layer.

export const RC_LIT_SEARCH_RESPONSE = {
  items: [
    {
      id: '019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit'],
      abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
      doi: '10.48550/arXiv.1706.03762',
      url: 'https://arxiv.org/abs/1706.03762',
      arxiv_id: '1706.03762',
      pdf_path: '/papers/attention-is-all-you-need.pdf',
      source: 'arxiv',
      source_id: '1706.03762',
      venue: 'NeurIPS 2017',
      year: 2017,
      added_at: '2026-03-10T08:30:00.000Z',
      updated_at: '2026-03-12T14:22:00.000Z',
      read_status: 'read' as const,
      rating: 5,
      notes: 'Foundational transformer paper. Key insight: self-attention replaces recurrence.',
      bibtex_key: 'vaswani2017attention',
      metadata: { impact_factor: 'high', cited_by_count: 120000 },
      tags: ['transformers', 'NLP', 'deep-learning'],
    },
  ],
  total: 1,
};

// ── rc.lit.tags response ─────────────────────────────────────────────────
// Source: literature/service.ts getTags() returns Tag[]
// Tag shape: literature/service.ts:82-88

export const RC_LIT_TAGS_RESPONSE = [
  { id: 'tag-001', name: 'transformers', color: '#8B5CF6', created_at: '2026-03-10T08:30:00.000Z', paper_count: 1 },
  { id: 'tag-002', name: 'NLP', color: '#3B82F6', created_at: '2026-03-10T08:30:00.000Z', paper_count: 2 },
  { id: 'tag-003', name: 'deep-learning', color: '#EF4444', created_at: '2026-03-10T08:30:00.000Z', paper_count: 1 },
  { id: 'tag-004', name: 'pre-training', color: null, created_at: '2026-03-11T10:15:00.000Z', paper_count: 1 },
];

// ── rc.task.list response ────────────────────────────────────────────────
// Source: tasks/rpc.ts:169-189 → service.list() returns { items: Task[], total: number }
// Task shape: tasks/service.ts:25-41

export const RC_TASK_LIST_RESPONSE = {
  items: [
    {
      id: 'task-001-uuid-placeholder',
      title: 'Read Vaswani et al. 2017 — Attention Is All You Need',
      description: 'Read the full paper and write a 2-page summary of key contributions.',
      task_type: 'human' as const,
      status: 'in_progress' as const,
      priority: 'high' as const,
      deadline: '2026-03-15T23:59:00.000Z',
      completed_at: null,
      created_at: '2026-03-10T09:00:00.000Z',
      updated_at: '2026-03-12T14:30:00.000Z',
      parent_task_id: null,
      related_paper_id: '019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f',
      related_file_path: null,
      agent_session_id: null,
      tags: ['reading', 'literature-review'],
      notes: null,
    },
    {
      id: 'task-002-uuid-placeholder',
      title: 'Run arXiv scan for transformer efficiency papers',
      description: null,
      task_type: 'agent' as const,
      status: 'todo' as const,
      priority: 'medium' as const,
      deadline: null,
      completed_at: null,
      created_at: '2026-03-11T11:00:00.000Z',
      updated_at: '2026-03-11T11:00:00.000Z',
      parent_task_id: null,
      related_paper_id: null,
      related_file_path: null,
      agent_session_id: 'agent:main:main',
      tags: ['monitoring'],
      notes: null,
    },
    {
      id: 'task-003-uuid-placeholder',
      title: 'Write related work section draft',
      description: 'Cover attention mechanisms, scaling laws, and BERT variants.',
      task_type: 'mixed' as const,
      status: 'blocked' as const,
      priority: 'urgent' as const,
      deadline: '2026-03-20T12:00:00.000Z',
      completed_at: null,
      created_at: '2026-03-09T16:00:00.000Z',
      updated_at: '2026-03-12T10:00:00.000Z',
      parent_task_id: null,
      related_paper_id: null,
      related_file_path: null,
      agent_session_id: null,
      tags: ['writing', 'paper-draft'],
      notes: 'Blocked: waiting for literature review to finish.',
    },
  ],
  total: 3,
};

// ── rc.task.get response ──────────────────────────────────────────────────
// Source: tasks/rpc.ts:193-207 → service.get() returns TaskWithDetails
// TaskWithDetails shape: tasks/service.ts:103-106 (Task + activity_log + subtasks)

export const RC_TASK_GET_RESPONSE = {
  id: 'task-001-uuid-placeholder',
  title: 'Read Vaswani et al. 2017 — Attention Is All You Need',
  description: 'Read the full paper and write a 2-page summary of key contributions.',
  task_type: 'human' as const,
  status: 'in_progress' as const,
  priority: 'high' as const,
  deadline: '2026-03-15T23:59:00.000Z',
  completed_at: null,
  created_at: '2026-03-10T09:00:00.000Z',
  updated_at: '2026-03-12T14:30:00.000Z',
  parent_task_id: null,
  related_paper_id: '019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f',
      related_file_path: null,
  agent_session_id: null,
  tags: ['reading', 'literature-review'],
  notes: null,
  activity_log: [
    {
      id: 'log-uuid-001',
      task_id: 'task-001-uuid-placeholder',
      event_type: 'status_changed',
      old_value: 'todo',
      new_value: 'in_progress',
      actor: 'human' as const,
      created_at: '2026-03-12T14:30:00.000Z',
    },
    {
      id: 'log-uuid-002',
      task_id: 'task-001-uuid-placeholder',
      event_type: 'note_added',
      old_value: null,
      new_value: 'Started reading section 3 on multi-head attention.',
      actor: 'human' as const,
      created_at: '2026-03-12T10:00:00.000Z',
    },
    {
      id: 'log-uuid-003',
      task_id: 'task-001-uuid-placeholder',
      event_type: 'created',
      old_value: null,
      new_value: 'Read Vaswani et al. 2017 — Attention Is All You Need',
      actor: 'human' as const,
      created_at: '2026-03-10T09:00:00.000Z',
    },
  ],
  subtasks: [
    {
      id: 'subtask-001-uuid',
      title: 'Read abstract and introduction',
      description: null,
      task_type: 'human' as const,
      status: 'done' as const,
      priority: 'medium' as const,
      deadline: null,
      completed_at: '2026-03-11T15:00:00.000Z',
      created_at: '2026-03-10T09:05:00.000Z',
      updated_at: '2026-03-11T15:00:00.000Z',
      parent_task_id: 'task-001-uuid-placeholder',
      related_paper_id: null,
      related_file_path: null,
      agent_session_id: null,
      tags: [],
      notes: null,
    },
    {
      id: 'subtask-002-uuid',
      title: 'Read methodology section',
      description: null,
      task_type: 'human' as const,
      status: 'todo' as const,
      priority: 'medium' as const,
      deadline: null,
      completed_at: null,
      created_at: '2026-03-10T09:10:00.000Z',
      updated_at: '2026-03-10T09:10:00.000Z',
      parent_task_id: 'task-001-uuid-placeholder',
      related_paper_id: null,
      related_file_path: null,
      agent_session_id: null,
      tags: [],
      notes: null,
    },
  ],
};

// ── rc.task.create response ──────────────────────────────────────────────
// Source: tasks/rpc.ts:210-230 → service.create() returns Task (single object)
// Note: create wraps input in { task: ... } — service returns the created Task

export const RC_TASK_CREATE_RESPONSE = {
  id: 'task-004-new-uuid',
  title: 'Review BERT fine-tuning approaches',
  description: 'Survey fine-tuning strategies for BERT on NER tasks.',
  task_type: 'human' as const,
  status: 'todo' as const,
  priority: 'medium' as const,
  deadline: '2026-03-25T23:59:00.000Z',
  completed_at: null,
  created_at: '2026-03-14T10:00:00.000Z',
  updated_at: '2026-03-14T10:00:00.000Z',
  parent_task_id: null,
  related_paper_id: '019523a4-8c3d-7e00-9e4f-2b3c4d5e6f7a',
      related_file_path: null,
  agent_session_id: null,
  tags: ['survey'],
  notes: null,
};

// ── rc.task.complete response ────────────────────────────────────────────
// Source: tasks/rpc.ts:295-304 → service.complete() returns Task (updated, status=done)

export const RC_TASK_COMPLETE_RESPONSE = {
  id: 'task-001-uuid-placeholder',
  title: 'Read Vaswani et al. 2017 — Attention Is All You Need',
  description: 'Read the full paper and write a 2-page summary of key contributions.',
  task_type: 'human' as const,
  status: 'done' as const,
  priority: 'high' as const,
  deadline: '2026-03-15T23:59:00.000Z',
  completed_at: '2026-03-14T15:30:00.000Z',
  created_at: '2026-03-10T09:00:00.000Z',
  updated_at: '2026-03-14T15:30:00.000Z',
  parent_task_id: null,
  related_paper_id: '019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f',
      related_file_path: null,
  agent_session_id: null,
  tags: ['reading', 'literature-review'],
  notes: null,
};

// ── rc.task.delete response ──────────────────────────────────────────────
// Source: tasks/rpc.ts:308-316 → returns { ok: true, deleted: true, id }

export const RC_TASK_DELETE_RESPONSE = {
  ok: true,
  deleted: true,
  id: 'task-002-uuid-placeholder',
};

// ── sessions.list response ───────────────────────────────────────────────
// Source: OpenClaw gateway session-utils.types.ts:21
// Response: { sessions: GatewaySessionRow[] } where each row has key, label?, displayName?, derivedTitle?, updatedAt?, sessionId?, kind?
// The dashboard store passes { includeDerivedTitles: true }

export const SESSIONS_LIST_RESPONSE = {
  sessions: [
    {
      key: 'agent:main:main',
      label: undefined,
      displayName: 'Main',
      derivedTitle: 'Research discussion about transformers',
      updatedAt: 1710417600000, // 2026-03-14T12:00:00.000Z as epoch ms
      sessionId: 'sess-main-001',
      kind: 'agent',
    },
    {
      key: 'agent:main:project-a1b2c3d4',
      label: 'Literature Review Sprint',
      displayName: 'Literature Review Sprint',
      derivedTitle: 'Papers on attention mechanisms',
      updatedAt: 1710331200000, // 2026-03-13T12:00:00.000Z
      sessionId: 'sess-proj-002',
      kind: 'agent',
    },
    {
      key: 'agent:main:project-e5f6g7h8',
      label: undefined,
      displayName: undefined,
      derivedTitle: undefined,
      updatedAt: 1710244800000, // 2026-03-12T12:00:00.000Z
      sessionId: 'sess-proj-003',
      kind: 'agent',
    },
  ],
};

// ── sessions.delete response ─────────────────────────────────────────────
// Source: OpenClaw gateway sessions.delete → returns { ok: true }

export const SESSIONS_DELETE_RESPONSE = { ok: true };

// ── sessions.patch response ──────────────────────────────────────────────
// Source: OpenClaw gateway sessions.patch → returns { ok: true, key: string }

export const SESSIONS_PATCH_RESPONSE = {
  ok: true,
  key: 'agent:main:project-a1b2c3d4',
};

// ── Error responses ──────────────────────────────────────────────────────
// JSON-RPC error shapes thrown by the plugin and caught by the gateway

export const RPC_ERROR_METHOD_NOT_FOUND = {
  code: -32601,
  message: 'Method not found: rc.lit.nonexistent',
};

export const RPC_ERROR_INVALID_PARAMS = {
  code: -32011,
  message: 'title is required and must be a non-empty string',
};

export const RPC_ERROR_PAPER_NOT_FOUND = {
  code: -32001,
  message: 'Paper not found: nonexistent-id',
};

export const RPC_ERROR_TASK_NOT_FOUND = {
  code: -32001,
  message: 'Task not found: nonexistent-id',
};

// ── rc.lit.list empty response ───────────────────────────────────────────

export const RC_LIT_LIST_EMPTY_RESPONSE = {
  items: [],
  total: 0,
  offset: 0,
  limit: 50,
};

// ── rc.task.list empty response ──────────────────────────────────────────

export const RC_TASK_LIST_EMPTY_RESPONSE = {
  items: [],
  total: 0,
};

// ── sessions.list empty response ─────────────────────────────────────────

export const SESSIONS_LIST_EMPTY_RESPONSE = {
  sessions: [],
};
