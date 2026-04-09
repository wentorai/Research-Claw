/**
 * Literature Tag Tests — GAP-1 (Orphan Cleanup) & GAP-2 (Multi-Tag AND Filter)
 *
 * Verifies:
 * - Orphaned tags are cleaned up after paper deletion and untag
 * - Multi-tag AND filtering returns only papers with ALL specified tags
 * - Edge cases: non-existent tag combinations, idempotent cleanup, delete-all
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

import { createTestDb } from './setup.js';
import { LiteratureService, type PaperInput } from '../literature/service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaper(overrides: Partial<PaperInput> = {}): PaperInput {
  return {
    title: 'Test Paper',
    authors: ['Author A'],
    abstract: 'Abstract text',
    source: 'test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GAP-1: Tag Orphan Cleanup
// ---------------------------------------------------------------------------

describe('GAP-1: Tag Orphan Cleanup', () => {
  let db: BetterSqlite3.Database;
  let svc: LiteratureService;

  beforeEach(() => {
    db = createTestDb();
    svc = new LiteratureService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('cleans up orphaned tags after purging the last paper with that tag', () => {
    // Add 3 papers with different tag combinations
    const p1 = svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['vit', 'thyroid'] }));
    const p2 = svc.add(makePaper({ doi: '10.1/b', title: 'Paper B', tags: ['vit', 'cnn'] }));
    const p3 = svc.add(makePaper({ doi: '10.1/c', title: 'Paper C', tags: ['thyroid'] }));

    // Before deletion: 3 tags (vit, thyroid, cnn)
    let tags = svc.getTags();
    expect(tags).toHaveLength(3);

    // Soft-delete p2: tags are preserved (soft-delete is reversible)
    svc.delete(p2.id);
    tags = svc.getTags();
    expect(tags.map((t) => t.name)).toContain('cnn'); // still visible (paper could be restored)

    // Purge p2: now 'cnn' should be cleaned up (permanent removal)
    svc.purge(p2.id);
    tags = svc.getTags();
    const tagNames = tags.map((t) => t.name);
    expect(tagNames).not.toContain('cnn');
    expect(tagNames).toContain('vit');
    expect(tagNames).toContain('thyroid');
  });

  it('preserves tags that still have associated papers after purge', () => {
    const p1 = svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['ml', 'nlp'] }));
    const p2 = svc.add(makePaper({ doi: '10.1/b', title: 'Paper B', tags: ['ml'] }));

    // Purge p1 — 'nlp' becomes orphaned, but 'ml' still has p2
    svc.delete(p1.id);
    svc.purge(p1.id);

    const tags = svc.getTags();
    const tagNames = tags.map((t) => t.name);
    expect(tagNames).toContain('ml');
    expect(tagNames).not.toContain('nlp');

    // ml should have paper_count = 1
    const mlTag = tags.find((t) => t.name === 'ml');
    expect(mlTag!.paper_count).toBe(1);
  });

  it('cleans up all tags after purging all papers', () => {
    const p1 = svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['tag1', 'tag2'] }));
    const p2 = svc.add(makePaper({ doi: '10.1/b', title: 'Paper B', tags: ['tag2', 'tag3'] }));

    svc.delete(p1.id);
    svc.delete(p2.id);

    // Soft-delete preserves tags for restore
    let tags = svc.getTags();
    expect(tags).toHaveLength(3);

    // Purge cleans up orphans
    svc.purge(p1.id);
    svc.purge(p2.id);
    tags = svc.getTags();
    expect(tags).toHaveLength(0);
  });

  it('cleans up orphaned tags after untag removes the last association', () => {
    const p1 = svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['unique-tag', 'shared'] }));
    const p2 = svc.add(makePaper({ doi: '10.1/b', title: 'Paper B', tags: ['shared'] }));

    // Remove 'unique-tag' from p1 (it's the only paper with that tag)
    svc.untag(p1.id, 'unique-tag');

    const tags = svc.getTags();
    const tagNames = tags.map((t) => t.name);
    expect(tagNames).not.toContain('unique-tag');
    expect(tagNames).toContain('shared');
  });

  it('cleanup is idempotent (calling twice does not error)', () => {
    const p1 = svc.add(makePaper({ doi: '10.1/a', tags: ['orphan-test'] }));
    svc.delete(p1.id);
    svc.purge(p1.id);

    // Cleanup already happened inside purge()
    // Call it again manually — should not throw
    expect(() => svc.cleanupOrphanedTags()).not.toThrow();

    const tags = svc.getTags();
    expect(tags).toHaveLength(0);
  });

  it('does not remove tags when untag still leaves other papers with that tag', () => {
    const p1 = svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['shared'] }));
    const p2 = svc.add(makePaper({ doi: '10.1/b', title: 'Paper B', tags: ['shared'] }));

    svc.untag(p1.id, 'shared');

    const tags = svc.getTags();
    const sharedTag = tags.find((t) => t.name === 'shared');
    expect(sharedTag).toBeDefined();
    expect(sharedTag!.paper_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GAP-2: Multi-Tag AND Filter
// ---------------------------------------------------------------------------

describe('GAP-2: Multi-Tag AND Filter', () => {
  let db: BetterSqlite3.Database;
  let svc: LiteratureService;

  beforeEach(() => {
    db = createTestDb();
    svc = new LiteratureService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns only papers with ALL specified tags (AND logic)', () => {
    svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['vit', 'thyroid'] }));
    svc.add(makePaper({ doi: '10.1/b', title: 'Paper B', tags: ['vit', 'cnn'] }));
    svc.add(makePaper({ doi: '10.1/c', title: 'Paper C', tags: ['thyroid'] }));

    // Filter by both 'vit' AND 'thyroid' — only Paper A has both
    const result = svc.list({ filter: { tags: ['vit', 'thyroid'] } });
    expect(result.total).toBe(1);
    expect(result.items[0].title).toBe('Paper A');
  });

  it('single tag in tags array behaves same as old tag filter', () => {
    svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['ml'] }));
    svc.add(makePaper({ doi: '10.1/b', title: 'Paper B', tags: ['physics'] }));

    const resultTags = svc.list({ filter: { tags: ['ml'] } });
    const resultTag = svc.list({ filter: { tag: 'ml' } });

    expect(resultTags.total).toBe(1);
    expect(resultTag.total).toBe(1);
    expect(resultTags.items[0].id).toBe(resultTag.items[0].id);
  });

  it('returns empty array when no paper has all specified tags', () => {
    svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['vit'] }));
    svc.add(makePaper({ doi: '10.1/b', title: 'Paper B', tags: ['thyroid'] }));

    // No paper has both 'vit' AND 'thyroid'
    const result = svc.list({ filter: { tags: ['vit', 'thyroid'] } });
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it('filter by non-existent tag combination returns empty', () => {
    svc.add(makePaper({ doi: '10.1/a', tags: ['ml'] }));

    const result = svc.list({ filter: { tags: ['ml', 'nonexistent'] } });
    expect(result.total).toBe(0);
  });

  it('handles three or more tags in AND filter', () => {
    svc.add(makePaper({ doi: '10.1/a', title: 'Triple', tags: ['ml', 'nlp', 'cv'] }));
    svc.add(makePaper({ doi: '10.1/b', title: 'Double', tags: ['ml', 'nlp'] }));
    svc.add(makePaper({ doi: '10.1/c', title: 'Single', tags: ['ml'] }));

    const result = svc.list({ filter: { tags: ['ml', 'nlp', 'cv'] } });
    expect(result.total).toBe(1);
    expect(result.items[0].title).toBe('Triple');
  });

  it('tag filter is case-insensitive', () => {
    svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['ML'] }));

    // Tags are normalized to lowercase on insert; filter should also be case-insensitive
    const result = svc.list({ filter: { tags: ['ml'] } });
    expect(result.total).toBe(1);

    const resultUpperCase = svc.list({ filter: { tags: ['ML'] } });
    expect(resultUpperCase.total).toBe(1);
  });

  it('combines tag filter with other filters (read_status)', () => {
    const p1 = svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['ml'] }));
    const p2 = svc.add(makePaper({ doi: '10.1/b', title: 'Paper B', tags: ['ml'] }));
    svc.setStatus(p1.id, 'read');

    const result = svc.list({ filter: { tags: ['ml'], read_status: 'read' } });
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe(p1.id);
  });

  it('backward compat: singular tag field still works in list()', () => {
    svc.add(makePaper({ doi: '10.1/a', title: 'Paper A', tags: ['physics'] }));
    svc.add(makePaper({ doi: '10.1/b', title: 'Paper B', tags: ['math'] }));

    // Using the old-style singular tag field
    const result = svc.list({ filter: { tag: 'physics' } });
    expect(result.total).toBe(1);
    expect(result.items[0].title).toBe('Paper A');
  });
});
