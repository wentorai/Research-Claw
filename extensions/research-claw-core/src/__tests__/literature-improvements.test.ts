/**
 * Literature Library Improvements — Functional Tests
 *
 * Tests for the fix/literature-library-improvements branch:
 *   - Transaction atomicity for add()
 *   - N+1 query optimization (batch tag fetch)
 *   - FTS integrity auto-rebuild
 *   - restore() / purge() lifecycle
 *   - pdf_exists enrichment
 *   - New tool schemas (library_delete_paper, library_list_papers, library_zotero, library_endnote)
 *   - Collection list action
 *   - Full CRUD lifecycle: add → update → tag → search → delete → restore → purge
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

import { createTestDb } from './setup.js';
import { LiteratureService, type PaperInput } from '../literature/service.js';
import { createLiteratureTools } from '../literature/tools.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaper(overrides: Partial<PaperInput> = {}): PaperInput {
  return {
    title: 'Attention Is All You Need',
    authors: ['Vaswani, A.', 'Shazeer, N.'],
    abstract: 'The dominant sequence transduction models...',
    doi: '10.48550/arXiv.1706.03762',
    venue: 'NeurIPS',
    year: 2017,
    source: 'arxiv',
    ...overrides,
  };
}

let counter = 0;
function uniquePaper(overrides: Partial<PaperInput> = {}): PaperInput {
  counter++;
  return makePaper({
    title: `Paper ${counter}: ${overrides.title ?? 'Unique Test Paper'}`,
    doi: `10.test/${counter}`,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Literature Improvements', () => {
  let db: BetterSqlite3.Database;
  let svc: LiteratureService;

  beforeEach(() => {
    counter = 0;
    db = createTestDb();
    svc = new LiteratureService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Transaction atomicity ─────────────────────────────────────────────

  describe('add() transaction atomicity', () => {
    it('add with tags is atomic — paper and tags appear together', () => {
      const paper = svc.add(makePaper({ tags: ['deep-learning', 'nlp', 'transformers'] }));
      expect(paper.tags).toEqual(['deep-learning', 'nlp', 'transformers']);

      // Verify tags are in the DB, not just in the return value
      const fetched = svc.get(paper.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.tags).toEqual(['deep-learning', 'nlp', 'transformers']);
    });

    it('add does not leave orphaned rows on paper_type validation failure', () => {
      expect(() =>
        svc.add(makePaper({ doi: '10.test/bad-type', paper_type: 'invalid_type' as string })),
      ).toThrow(/Invalid paper_type/);

      // Verify no paper was inserted
      const result = svc.search('bad-type', 100, 0);
      expect(result.total).toBe(0);
    });
  });

  // ── N+1 optimization ─────────────────────────────────────────────────

  describe('batch tag fetch (N+1 fix)', () => {
    it('list() returns correct tags for multiple papers', () => {
      svc.add(uniquePaper({ tags: ['ml'] }));
      svc.add(uniquePaper({ tags: ['nlp'] }));
      svc.add(uniquePaper({ tags: ['ml', 'nlp'] }));

      const result = svc.list({ limit: 50 });
      expect(result.items).toHaveLength(3);

      const tagSets = result.items.map((p) => p.tags?.sort());
      expect(tagSets).toContainEqual(['ml']);
      expect(tagSets).toContainEqual(['nlp']);
      expect(tagSets).toContainEqual(['ml', 'nlp']);
    });

    it('search() returns correct tags for matching papers', () => {
      svc.add(uniquePaper({ title: 'Transformer Networks', tags: ['architecture'] }));
      svc.add(uniquePaper({ title: 'Transformer Models', tags: ['survey'] }));

      const result = svc.search('Transformer', 50, 0);
      expect(result.items.length).toBeGreaterThanOrEqual(2);

      const tags = result.items.flatMap((p) => p.tags ?? []);
      expect(tags).toContain('architecture');
      expect(tags).toContain('survey');
    });

    it('list() with no papers returns empty correctly', () => {
      const result = svc.list({ limit: 50 });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  // ── FTS integrity ─────────────────────────────────────────────────────

  describe('FTS integrity auto-rebuild', () => {
    it('search works on a fresh database (FTS was built by setup)', () => {
      svc.add(makePaper());
      const result = svc.search('Attention', 10, 0);
      expect(result.total).toBe(1);
    });

    it('rebuilds FTS if table is dropped', () => {
      svc.add(makePaper());

      // Simulate FTS corruption: drop the table
      db.exec('DROP TABLE IF EXISTS rc_papers_fts');

      // Create a new service instance — should auto-rebuild
      const svc2 = new LiteratureService(db);

      // Verify search still works after rebuild
      const result = svc2.search('Attention', 10, 0);
      expect(result.total).toBe(1);
    });

    it('FTS triggers are recreated when FTS table is rebuilt', () => {
      svc.add(makePaper({ doi: '10.test/fts-trigger-1' }));

      // Drop FTS + triggers
      db.exec('DROP TABLE IF EXISTS rc_papers_fts');
      db.exec('DROP TRIGGER IF EXISTS rc_papers_fts_insert');
      db.exec('DROP TRIGGER IF EXISTS rc_papers_fts_update');
      db.exec('DROP TRIGGER IF EXISTS rc_papers_fts_delete');

      // Rebuild via constructor
      const svc2 = new LiteratureService(db);

      // Add a paper AFTER rebuild — trigger should index it
      svc2.add(uniquePaper({ title: 'Post-rebuild paper about quantum computing' }));

      const result = svc2.search('quantum', 10, 0);
      expect(result.total).toBe(1);
    });
  });

  // ── delete edge cases ──────────────────────────────────────────────────

  describe('delete edge cases', () => {
    it('delete throws for non-existent paper', () => {
      expect(() => svc.delete('nonexistent-id')).toThrow('Paper not found');
    });

    it('soft-delete reduces tag paper_count to 0 but preserves tag', () => {
      const paper = svc.add(uniquePaper({ tags: ['ephemeral'] }));
      svc.delete(paper.id);

      const tags = svc.getTags();
      const tag = tags.find((t) => t.name === 'ephemeral');
      expect(tag).toBeDefined();
      expect(tag!.paper_count).toBe(0);
    });
  });

  // ── restore / purge lifecycle ─────────────────────────────────────────

  describe('restore and purge', () => {
    it('restore recovers a soft-deleted paper', () => {
      const paper = svc.add(makePaper({ tags: ['important'] }));
      svc.delete(paper.id);

      // Paper should not appear in list
      const hidden = svc.list({ limit: 50 });
      expect(hidden.items.find((p) => p.id === paper.id)).toBeUndefined();

      // Restore it
      const restored = svc.restore(paper.id);
      expect(restored.id).toBe(paper.id);
      expect(restored.title).toBe('Attention Is All You Need');

      // Paper should appear in list again
      const visible = svc.list({ limit: 50 });
      expect(visible.items.find((p) => p.id === paper.id)).toBeDefined();
    });

    it('restore preserves tags', () => {
      const paper = svc.add(makePaper({ tags: ['ml', 'nlp'] }));
      svc.delete(paper.id);
      const restored = svc.restore(paper.id);
      // Tags are preserved since soft-delete doesn't touch junction table
      // (junction entries still exist, just hidden by NOT_DELETED filter on papers)
      expect(restored.tags).toEqual(['ml', 'nlp']);
    });

    it('restore throws for non-deleted paper (distinct from not-found)', () => {
      const paper = svc.add(makePaper());
      // Paper exists but is NOT soft-deleted — must throw with "not deleted" message
      expect(() => svc.restore(paper.id)).toThrow('Paper not found or not deleted');
    });

    it('restore throws for non-existent paper', () => {
      expect(() => svc.restore('nonexistent-id')).toThrow('Paper not found or not deleted');
    });

    it('purge permanently removes a soft-deleted paper', () => {
      const paper = svc.add(makePaper({ tags: ['disposable'] }));
      svc.delete(paper.id);
      svc.purge(paper.id);

      // Cannot restore after purge
      expect(() => svc.restore(paper.id)).toThrow(/not found or not deleted/);

      // Cannot get even with direct SQL
      const row = db.prepare('SELECT * FROM rc_papers WHERE id = ?').get(paper.id);
      expect(row).toBeUndefined();
    });

    it('purge cleans up orphaned tags', () => {
      const paper = svc.add(makePaper({ tags: ['unique-tag-for-purge'] }));
      svc.delete(paper.id);
      svc.purge(paper.id);

      const tags = svc.getTags();
      expect(tags.find((t) => t.name === 'unique-tag-for-purge')).toBeUndefined();
    });

    it('purge throws for non-deleted paper', () => {
      const paper = svc.add(makePaper());
      expect(() => svc.purge(paper.id)).toThrow('Paper not found or not deleted');
    });

    it('purge throws for non-existent paper', () => {
      expect(() => svc.purge('nonexistent-id')).toThrow('Paper not found or not deleted');
    });

    it('purge cascades to junction tables', () => {
      const paper = svc.add(makePaper({ tags: ['cascade-test'] }));
      const paperId = paper.id;
      svc.delete(paperId);
      svc.purge(paperId);

      // Check paper_tags junction is cleaned
      const junctionRow = db
        .prepare('SELECT * FROM rc_paper_tags WHERE paper_id = ?')
        .get(paperId);
      expect(junctionRow).toBeUndefined();
    });
  });

  // ── Full CRUD lifecycle ───────────────────────────────────────────────

  describe('full CRUD lifecycle', () => {
    it('add → update → tag → search → delete → restore → purge', () => {
      // 1. Add
      const paper = svc.add(makePaper({ doi: '10.test/lifecycle' }));
      expect(paper.read_status).toBe('unread');

      // 2. Update
      const updated = svc.update(paper.id, {
        read_status: 'reading',
        notes: 'Very important paper',
      });
      expect(updated.read_status).toBe('reading');
      expect(updated.notes).toBe('Very important paper');

      // 3. Tag
      svc.tag(paper.id, 'ml');
      svc.tag(paper.id, 'transformers');
      const tagged = svc.get(paper.id);
      expect(tagged!.tags).toEqual(['ml', 'transformers']);

      // 4. Search
      const found = svc.search('Attention', 10, 0);
      expect(found.total).toBe(1);
      expect(found.items[0].id).toBe(paper.id);
      expect(found.items[0].tags).toEqual(['ml', 'transformers']);

      // 5. Delete (soft)
      svc.delete(paper.id);
      const afterDelete = svc.search('Attention', 10, 0);
      expect(afterDelete.total).toBe(0);

      // 6. Restore
      const restored = svc.restore(paper.id);
      expect(restored.notes).toBe('Very important paper');
      expect(restored.tags).toEqual(['ml', 'transformers']);

      // 7. Delete again then purge
      svc.delete(paper.id);
      svc.purge(paper.id);
      expect(() => svc.restore(paper.id)).toThrow();

      // Verify complete removal
      const finalSearch = svc.search('Attention', 10, 0);
      expect(finalSearch.total).toBe(0);
    });
  });

  // ── list() with filters ───────────────────────────────────────────────

  describe('list with filters (library_list_papers tool coverage)', () => {
    it('filters by read_status', () => {
      const p1 = svc.add(uniquePaper());
      const p2 = svc.add(uniquePaper());
      svc.setStatus(p1.id, 'reading');

      const reading = svc.list({ filter: { read_status: 'reading' as string } });
      expect(reading.items).toHaveLength(1);
      expect(reading.items[0].id).toBe(p1.id);

      const unread = svc.list({ filter: { read_status: 'unread' as string } });
      expect(unread.items).toHaveLength(1);
      expect(unread.items[0].id).toBe(p2.id);
    });

    it('filters by tags (AND logic)', () => {
      svc.add(uniquePaper({ tags: ['ml'] }));
      svc.add(uniquePaper({ tags: ['ml', 'nlp'] }));
      svc.add(uniquePaper({ tags: ['nlp'] }));

      const both = svc.list({ filter: { tags: ['ml', 'nlp'] } });
      expect(both.items).toHaveLength(1);
      expect(both.items[0].tags).toEqual(['ml', 'nlp']);
    });

    it('filters by year', () => {
      svc.add(uniquePaper({ year: 2020 }));
      svc.add(uniquePaper({ year: 2023 }));

      const result = svc.list({ filter: { year: 2023 } });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].year).toBe(2023);
    });

    it('sorts by different fields', () => {
      svc.add(uniquePaper({ year: 2020, title: 'Alpha' }));
      svc.add(uniquePaper({ year: 2023, title: 'Beta' }));

      const byYear = svc.list({ sort: 'year' });
      expect(byYear.items[0].year).toBe(2023); // DESC by default

      const byTitle = svc.list({ sort: '+title' });
      // '+' prefix means ASC
      expect(byTitle.items[0].title).toMatch(/Alpha/);
    });

    it('paginates correctly', () => {
      for (let i = 0; i < 5; i++) svc.add(uniquePaper());

      const page1 = svc.list({ limit: 2, offset: 0 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = svc.list({ limit: 2, offset: 2 });
      expect(page2.items).toHaveLength(2);

      const page3 = svc.list({ limit: 2, offset: 4 });
      expect(page3.items).toHaveLength(1);
    });
  });

  // ── Collection list ───────────────────────────────────────────────────

  describe('collection list action', () => {
    it('listCollections returns all collections with paper counts', () => {
      const c1 = svc.manageCollection('create', { name: 'Survey Papers' });
      const c2 = svc.manageCollection('create', { name: 'To Read' });

      const paper = svc.add(uniquePaper());
      svc.manageCollection('add_paper', { id: c1.id, paper_ids: [paper.id] });

      const collections = svc.listCollections();
      expect(collections).toHaveLength(2);

      const survey = collections.find((c) => c.name === 'Survey Papers');
      expect(survey).toBeDefined();
      expect(survey!.paper_count).toBe(1);

      const toRead = collections.find((c) => c.name === 'To Read');
      expect(toRead).toBeDefined();
      expect(toRead!.paper_count).toBe(0);
    });
  });

  // ── Tool definition tests ─────────────────────────────────────────────

  describe('tool definitions', () => {
    it('creates 17 tools', () => {
      const tools = createLiteratureTools(svc);
      expect(tools).toHaveLength(17);
    });

    it('all tools have name, description, parameters, and execute', () => {
      const tools = createLiteratureTools(svc);
      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.type).toBe('object');
        expect(typeof tool.execute).toBe('function');
      }
    });

    it('includes library_delete_paper', () => {
      const tools = createLiteratureTools(svc);
      const deleteTool = tools.find((t) => t.name === 'library_delete_paper');
      expect(deleteTool).toBeDefined();
      expect(deleteTool!.parameters.required).toEqual(['id']);
    });

    it('includes library_list_papers', () => {
      const tools = createLiteratureTools(svc);
      const listTool = tools.find((t) => t.name === 'library_list_papers');
      expect(listTool).toBeDefined();
      // No required params
      expect(listTool!.parameters.required).toBeUndefined();
    });

    it('includes consolidated library_zotero with 6 actions', () => {
      const tools = createLiteratureTools(svc);
      const zoteroTool = tools.find((t) => t.name === 'library_zotero');
      expect(zoteroTool).toBeDefined();
      const actionProp = (zoteroTool!.parameters.properties as Record<string, { enum?: string[] }>).action;
      expect(actionProp.enum).toEqual(['detect', 'import', 'search', 'create', 'update', 'delete']);
    });

    it('includes consolidated library_endnote with 2 actions', () => {
      const tools = createLiteratureTools(svc);
      const endnoteTool = tools.find((t) => t.name === 'library_endnote');
      expect(endnoteTool).toBeDefined();
      const actionProp = (endnoteTool!.parameters.properties as Record<string, { enum?: string[] }>).action;
      expect(actionProp.enum).toEqual(['detect', 'import']);
    });

    it('library_manage_collection includes list action', () => {
      const tools = createLiteratureTools(svc);
      const collTool = tools.find((t) => t.name === 'library_manage_collection');
      expect(collTool).toBeDefined();
      const actionProp = (collTool!.parameters.properties as Record<string, { enum?: string[] }>).action;
      expect(actionProp.enum).toContain('list');
    });
  });

  // ── Tool execution tests ──────────────────────────────────────────────

  describe('tool execution (real calls)', () => {
    it('library_add_paper execute returns paper_card instruction', async () => {
      const tools = createLiteratureTools(svc);
      const addTool = tools.find((t) => t.name === 'library_add_paper')!;

      const result = await addTool.execute('test-call-1', {
        title: 'Test Paper for Tool',
        authors: ['Author, A.'],
        doi: '10.test/tool-exec',
      }) as { content: Array<{ text: string }>; details: Record<string, unknown> };

      expect(result.content[0].text).toContain('Added paper');
      expect(result.content[0].text).toContain('paper_card');
      expect(result.details).toHaveProperty('id');
    });

    it('library_delete_paper execute soft-deletes', async () => {
      const paper = svc.add(uniquePaper());
      const tools = createLiteratureTools(svc);
      const deleteTool = tools.find((t) => t.name === 'library_delete_paper')!;

      const result = await deleteTool.execute('test-call-2', {
        id: paper.id,
      }) as { content: Array<{ text: string }> };

      expect(result.content[0].text).toContain('Deleted');

      // Paper is soft-deleted
      expect(svc.get(paper.id)).toBeNull();
    });

    it('library_delete_paper fails with empty id', async () => {
      const tools = createLiteratureTools(svc);
      const deleteTool = tools.find((t) => t.name === 'library_delete_paper')!;

      const result = await deleteTool.execute('test-call-3', {
        id: '',
      }) as { content: Array<{ text: string }> };

      expect(result.content[0].text).toContain('Error');
    });

    it('library_list_papers execute returns paginated results', async () => {
      for (let i = 0; i < 3; i++) svc.add(uniquePaper());
      const tools = createLiteratureTools(svc);
      const listTool = tools.find((t) => t.name === 'library_list_papers')!;

      const result = await listTool.execute('test-call-4', {
        limit: 2,
      }) as { content: Array<{ text: string }>; details: { items: unknown[]; total: number } };

      expect(result.content[0].text).toContain('Found 3');
      expect(result.content[0].text).toContain('showing 2');
      expect(result.details.total).toBe(3);
      expect(result.details.items).toHaveLength(2);
    });

    it('library_list_papers execute with read_status filter', async () => {
      const p = svc.add(uniquePaper());
      svc.add(uniquePaper());
      svc.setStatus(p.id, 'reading');

      const tools = createLiteratureTools(svc);
      const listTool = tools.find((t) => t.name === 'library_list_papers')!;

      const result = await listTool.execute('test-call-5', {
        read_status: 'reading',
      }) as { details: { items: unknown[]; total: number } };

      expect(result.details.total).toBe(1);
    });

    it('library_manage_collection list action returns collections', async () => {
      svc.manageCollection('create', { name: 'Test Collection' });

      const tools = createLiteratureTools(svc);
      const collTool = tools.find((t) => t.name === 'library_manage_collection')!;

      const result = await collTool.execute('test-call-6', {
        action: 'list',
      }) as { content: Array<{ text: string }>; details: { collections: unknown[] } };

      expect(result.content[0].text).toContain('Found 1 collection');
      expect(result.details.collections).toHaveLength(1);
    });

    it('library_search returns no error for empty results', async () => {
      const tools = createLiteratureTools(svc);
      const searchTool = tools.find((t) => t.name === 'library_search')!;

      const result = await searchTool.execute('test-call-7', {
        query: 'nonexistent paper xyzzy',
      }) as { content: Array<{ text: string }> };

      expect(result.content[0].text).toContain('Found 0');
      expect(result.content[0].text).not.toContain('Error');
    });

    it('library_batch_add reports duplicates correctly', async () => {
      svc.add(makePaper({ doi: '10.test/dup' }));

      const tools = createLiteratureTools(svc);
      const batchTool = tools.find((t) => t.name === 'library_batch_add')!;

      const result = await batchTool.execute('test-call-8', {
        papers: [
          { title: 'New Paper 1', doi: '10.test/new1' },
          { title: 'Duplicate Paper', doi: '10.test/dup' },
          { title: 'New Paper 2', doi: '10.test/new2' },
        ],
      }) as { content: Array<{ text: string }>; details: { added: unknown[]; duplicates: unknown[] } };

      expect(result.content[0].text).toContain('Added 2');
      expect(result.content[0].text).toContain('1 duplicate');
      expect(result.details.added).toHaveLength(2);
      expect(result.details.duplicates).toHaveLength(1);
    });
  });
});
