/**
 * Card Serialization Unit Tests
 *
 * Tests for serializeCard, parseMessageCards, and edge cases.
 * Validates all 6 card types against the protocol definition.
 */

import { describe, it, expect } from 'vitest';

import {
  type PaperCard,
  type TaskCard,
  type ProgressCard,
  type ApprovalCard,
  type FileCard,
  type MonitorDigest,
  type MessageCard,
  CARD_TYPES,
} from '../cards/protocol.js';

import {
  serializeCard,
  serializeCards,
  parseMessageCards,
  type ParsedBlock,
} from '../cards/serializer.js';

// ---------------------------------------------------------------------------
// serializeCard
// ---------------------------------------------------------------------------

describe('serializeCard', () => {
  it('serializes a paper_card', () => {
    const card: PaperCard = {
      type: 'paper_card',
      title: 'Attention Is All You Need',
      authors: ['Vaswani, A.'],
      venue: 'NeurIPS',
      year: 2017,
      doi: '10.48550/arXiv.1706.03762',
    };

    const result = serializeCard(card);
    expect(result).toMatch(/^```paper_card\n/);
    expect(result).toMatch(/\n```$/);
    expect(result).toContain('"type": "paper_card"');
    expect(result).toContain('"title": "Attention Is All You Need"');
  });

  it('serializes a task_card', () => {
    const card: TaskCard = {
      type: 'task_card',
      id: 't-001',
      title: 'Review methodology',
      task_type: 'human',
      status: 'todo',
      priority: 'high',
      deadline: '2026-03-15T23:59:00+08:00',
    };

    const result = serializeCard(card);
    expect(result).toMatch(/^```task_card\n/);
    expect(result).toContain('"task_type": "human"');
    expect(result).toContain('"priority": "high"');
  });

  it('serializes a progress_card', () => {
    const card: ProgressCard = {
      type: 'progress_card',
      period: 'session',
      papers_read: 2,
      papers_added: 5,
      tasks_completed: 1,
      tasks_created: 3,
      writing_words: 1200,
      highlights: ['Found key insight'],
    };

    const result = serializeCard(card);
    expect(result).toMatch(/^```progress_card\n/);
    expect(result).toContain('"papers_read": 2');
  });

  it('serializes an approval_card', () => {
    const card: ApprovalCard = {
      type: 'approval_card',
      action: 'Delete 3 duplicate papers',
      context: 'Found exact duplicates by DOI',
      risk_level: 'medium',
      details: { affected_count: 3 },
    };

    const result = serializeCard(card);
    expect(result).toMatch(/^```approval_card\n/);
    expect(result).toContain('"risk_level": "medium"');
  });

  it('serializes a monitor_digest', () => {
    const card: MonitorDigest = {
      type: 'monitor_digest',
      monitor_name: 'arXiv Daily',
      source_type: 'arxiv',
      target: 'transformer attention',
      total_found: 47,
      findings: [
        {
          title: 'Efficient Multi-Scale Attention',
          url: 'https://arxiv.org/abs/2026.12345',
          summary: 'Reduces FLOPs by 40%',
        },
      ],
    };

    const result = serializeCard(card);
    expect(result).toMatch(/^```monitor_digest\n/);
    expect(result).toContain('"total_found": 47');
  });

  it('serializes a file_card', () => {
    const card: FileCard = {
      type: 'file_card',
      name: 'methodology.md',
      path: 'notes/methodology.md',
      size_bytes: 2340,
      mime_type: 'text/markdown',
      git_status: 'modified',
    };

    const result = serializeCard(card);
    expect(result).toMatch(/^```file_card\n/);
    expect(result).toContain('"git_status": "modified"');
  });
});

// ---------------------------------------------------------------------------
// serializeCards
// ---------------------------------------------------------------------------

describe('serializeCards', () => {
  it('joins multiple cards with blank lines', () => {
    const cards: MessageCard[] = [
      { type: 'paper_card', title: 'Paper A', authors: [] },
      { type: 'task_card', title: 'Task A', task_type: 'human', status: 'todo', priority: 'medium' },
    ];

    const result = serializeCards(cards);
    expect(result).toContain('```paper_card');
    expect(result).toContain('```task_card');
    // Should have a blank line separating them
    expect(result).toMatch(/```\n\n```/);
  });

  it('handles empty array', () => {
    expect(serializeCards([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseMessageCards
// ---------------------------------------------------------------------------

describe('parseMessageCards', () => {
  it('parses a single card from markdown', () => {
    const md = `Here is a paper:

\`\`\`paper_card
{"title":"Test Paper","authors":["A"]}
\`\`\`

Some more text.`;

    const blocks = parseMessageCards(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paper_card');
    expect(blocks[0].card).toBeDefined();
    expect(blocks[0].card!.type).toBe('paper_card');
    expect((blocks[0].card as PaperCard).title).toBe('Test Paper');
  });

  it('parses multiple card types', () => {
    const md = `\`\`\`paper_card
{"title":"P","authors":[]}
\`\`\`

\`\`\`task_card
{"title":"T","task_type":"human","status":"todo","priority":"medium"}
\`\`\``;

    const blocks = parseMessageCards(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('paper_card');
    expect(blocks[1].type).toBe('task_card');
  });

  it('reports error for invalid JSON', () => {
    const md = `\`\`\`paper_card
{not valid json}
\`\`\``;

    const blocks = parseMessageCards(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].error).toBeTruthy();
    expect(blocks[0].card).toBeUndefined();
  });

  it('reports error for non-object JSON', () => {
    const md = `\`\`\`paper_card
[1, 2, 3]
\`\`\``;

    const blocks = parseMessageCards(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].error).toContain('must be a JSON object');
  });

  it('injects type field when missing', () => {
    const md = `\`\`\`paper_card
{"title":"No Type","authors":[]}
\`\`\``;

    const blocks = parseMessageCards(md);
    expect(blocks[0].card).toBeDefined();
    expect(blocks[0].card!.type).toBe('paper_card');
  });

  it('rejects card with mismatched type field', () => {
    const md = `\`\`\`paper_card
{"type":"task_card","title":"Mismatch"}
\`\`\``;

    const blocks = parseMessageCards(md);
    expect(blocks[0].error).toContain('mismatch');
  });

  it('passes through non-card code blocks', () => {
    const md = `\`\`\`python
print("hello")
\`\`\``;

    const blocks = parseMessageCards(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('python');
    expect(blocks[0].card).toBeUndefined();
    expect(blocks[0].error).toBeUndefined();
    expect(blocks[0].raw).toContain('print("hello")');
  });

  it('handles code blocks with no language tag', () => {
    const md = `\`\`\`
plain text
\`\`\``;

    const blocks = parseMessageCards(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('unknown');
    expect(blocks[0].card).toBeUndefined();
  });

  it('handles markdown with no code blocks', () => {
    const md = 'Just regular markdown text. No code blocks here.';
    const blocks = parseMessageCards(md);
    expect(blocks).toHaveLength(0);
  });

  it('handles 4-backtick fences', () => {
    const md = `\`\`\`\`paper_card
{"title":"Four backticks","authors":[]}
\`\`\`\``;

    const blocks = parseMessageCards(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].card).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles empty string fields', () => {
    const card: PaperCard = {
      type: 'paper_card',
      title: '',
      authors: [],
    };

    const serialized = serializeCard(card);
    expect(serialized).toContain('"title": ""');

    const blocks = parseMessageCards(serialized);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].card).toBeDefined();
    expect((blocks[0].card as PaperCard).title).toBe('');
  });

  it('handles very long strings', () => {
    const longTitle = 'A'.repeat(10000);
    const card: PaperCard = {
      type: 'paper_card',
      title: longTitle,
      authors: [],
    };

    const serialized = serializeCard(card);
    const blocks = parseMessageCards(serialized);
    expect(blocks).toHaveLength(1);
    expect((blocks[0].card as PaperCard).title).toBe(longTitle);
  });

  it('handles special characters in JSON', () => {
    const card: PaperCard = {
      type: 'paper_card',
      title: 'Title with "quotes" and \\ backslashes',
      authors: ['O\'Brien, J.'],
    };

    const serialized = serializeCard(card);
    const blocks = parseMessageCards(serialized);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].card).toBeDefined();
  });

  it('round-trips all 6 card types', () => {
    const cards: MessageCard[] = [
      { type: 'paper_card', title: 'Test', authors: [] },
      { type: 'task_card', title: 'Task', task_type: 'agent', status: 'todo', priority: 'low' },
      { type: 'progress_card', period: 'today', papers_read: 0, papers_added: 0, tasks_completed: 0, tasks_created: 0 },
      { type: 'approval_card', action: 'Test', context: 'Test', risk_level: 'low' },
      { type: 'monitor_digest', monitor_name: 'Test', source_type: 'arxiv', target: 'test', total_found: 0, findings: [] },
      { type: 'file_card', name: 'test.md', path: 'notes/test.md' },
    ];

    for (const card of cards) {
      const serialized = serializeCard(card);
      const blocks = parseMessageCards(serialized);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].card).toBeDefined();
      expect(blocks[0].card!.type).toBe(card.type);
    }
  });

  it('CARD_TYPES set has exactly 6 members', () => {
    expect(CARD_TYPES.size).toBe(6);
    expect(CARD_TYPES.has('paper_card')).toBe(true);
    expect(CARD_TYPES.has('task_card')).toBe(true);
    expect(CARD_TYPES.has('progress_card')).toBe(true);
    expect(CARD_TYPES.has('approval_card')).toBe(true);
    expect(CARD_TYPES.has('file_card')).toBe(true);
    expect(CARD_TYPES.has('monitor_digest')).toBe(true);
  });
});
