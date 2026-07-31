import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestDb } from './setup.js';
import {
  adaptLiteraturePresentation,
  normalizeArxivId,
  normalizeDoi,
} from '../presentation/paper-adapters.js';
import { ExecutionTraceService } from '../execution-trace/service.js';
import { PresentationCoordinator } from '../presentation/coordinator.js';
import { PresentationService } from '../presentation/service.js';

const live = JSON.parse(fs.readFileSync(
  new URL('./fixtures/presentation-hooks-live-2026.6.1.json', import.meta.url), 'utf8',
)) as Record<string, any>;
const incident = JSON.parse(fs.readFileSync(
  new URL('./fixtures/presentation-incident-persisted-2026-07-31.json', import.meta.url), 'utf8',
)) as Record<string, any>;

function appendBatch(
  service: PresentationService,
  toolName: string,
  payload: NonNullable<ReturnType<typeof adaptLiteraturePresentation>>,
  options: { runId?: string; toolCallId?: string; source?: 'full' | 'persisted' } = {},
) {
  return service.append({
    sessionKey: 'session-a',
    runId: options.runId ?? 'run-a',
    toolCallId: options.toolCallId ?? `call-${toolName}`,
    toolName,
    source: options.source ?? 'full',
    completeness: options.source === 'persisted' ? 'partial' : 'complete',
    payload,
  });
}

describe('strict literature provider adapters', () => {
  it.each([
    ['get_arxiv_paper', 'arxiv'],
    ['search_openalex', 'openalex'],
    ['search_crossref', 'crossref'],
    ['search_arxiv', 'arxiv'],
    ['search_dblp', 'dblp'],
    ['rp_search', 'research-papers'],
  ])('projects the real positive full payload for %s', (toolName, provider) => {
    const hook = live.cases[toolName].after_tool_call.event;
    const batch = adaptLiteraturePresentation(toolName, hook.result, {
      source: 'full', params: hook.params,
    });
    expect(batch).toMatchObject({
      kind: 'paper_batch', semantic: 'retrieved', provider,
      returned: 1, eligible: 1, stored: 1, queryUnavailable: false,
    });
    expect(batch?.query).toEqual(expect.any(String));
    expect(batch?.candidates[0].title).toEqual(expect.any(String));
    expect(batch?.candidates[0].returnIndex).toBe(1);
  });

  it('supports Wentor only through its checked-in real persisted success shape', () => {
    const persisted = incident.persistedOnly.wentor_network_success.persistedTranscriptRecord.message;
    const batch = adaptLiteraturePresentation('wentor-network__search_papers', persisted, { source: 'persisted' });
    expect(batch).toMatchObject({
      provider: 'wentor-network', returned: 25, eligible: 25, stored: 20,
      queryUnavailable: true,
    });
    expect(adaptLiteraturePresentation(
      'wentor-network__search_papers', { details: { results: [], meta: {} } }, { source: 'full' },
    )).toBeNull();
  });

  it('recovers capped persisted content per provider without treating capped details as full', () => {
    for (const toolName of ['search_openalex', 'search_crossref', 'search_arxiv', 'rp_search']) {
      const message = incident.capped[toolName].persistedTranscriptRecord.message;
      const batch = adaptLiteraturePresentation(toolName, message, { source: 'persisted' });
      expect(batch?.returned).toBe(toolName === 'rp_search' ? 30 : 25);
      expect(batch?.persistedDetailsTruncated).toBe(true);
      expect(batch?.candidates.length).toBeGreaterThan(0);
    }
  });

  it('keeps a real zero-result batch distinct from an unavailable adapter result', () => {
    const zeroMessage = incident.persistedOnly.search_dblp_zero.persistedTranscriptRecord.message;
    const zero = adaptLiteraturePresentation('search_dblp', zeroMessage, { source: 'persisted' });
    expect(zero).toMatchObject({ status: 'available', returned: 0, eligible: 0, stored: 0 });
    const service = new PresentationService(createTestDb());
    appendBatch(service, 'search_dblp', zero!, { source: 'persisted' });
    expect(service.getRuns('session-a', ['run-a'])['run-a'].paperCandidates).toMatchObject({
      hasAvailableResults: true,
      returned: 0,
      unavailableProviders: [],
    });
  });

  it('projects the real Wentor persisted error as unavailable without inventing zero results', () => {
    const db = createTestDb();
    const service = new PresentationService(db);
    const coordinator = new PresentationCoordinator(service, new ExecutionTraceService(db));
    const transcript = incident.persistedOnly.wentor_network_error.persistedTranscriptRecord;
    const toolCallId = transcript.message.toolCallId;
    coordinator.beforeTool({
      toolName: transcript.message.toolName, runId: 'run-a', toolCallId,
    }, { sessionKey: 'session-a', runId: 'run-a', toolCallId });
    expect(coordinator.persistedToolResult({
      toolName: transcript.message.toolName,
      toolCallId,
      message: transcript.message,
    }, { sessionKey: 'session-a', toolCallId })).toMatchObject({ appended: true });

    expect(service.getRuns('session-a', ['run-a'])['run-a'].paperCandidates).toMatchObject({
      hasAvailableResults: false,
      returned: 0,
      unavailableProviders: ['wentor-network'],
      candidates: [],
    });
  });

  it('marks persisted-only Wentor support as partial', () => {
    const message = incident.persistedOnly.wentor_network_success.persistedTranscriptRecord.message;
    const batch = adaptLiteraturePresentation('wentor-network__search_papers', message, { source: 'persisted' })!;
    const service = new PresentationService(createTestDb());
    appendBatch(service, 'wentor-network__search_papers', batch, { source: 'persisted' });
    expect(service.getRuns('session-a', ['run-a'])['run-a'].paperCandidates).toMatchObject({
      providers: ['wentor-network'],
      partialProviders: ['wentor-network'],
      unavailableProviders: [],
    });
  });

  it('normalizes DOI URLs and arXiv versions while rejecting unsafe identities and URLs', () => {
    expect(normalizeDoi('https://doi.org/10.1000/ABC.1')).toBe('10.1000/abc.1');
    expect(normalizeDoi('doi:10.1000/ABC.1')).toBe('10.1000/abc.1');
    expect(normalizeDoi('not-a-doi')).toBeNull();
    expect(normalizeArxivId('arXiv:1706.03762v7')).toBe('1706.03762');
    expect(normalizeArxivId('https://arxiv.org/abs/hep-th/9901001v2')).toBe('hep-th/9901001');

    const hostile = adaptLiteraturePresentation('search_openalex', {
      details: {
        total_count: 1,
        results: [{ id: 'https://openalex.org/W1', title: 'Hostile', oa_url: 'javascript:alert(1)' }],
      },
    }, { source: 'full' });
    expect(hostile).toMatchObject({ returned: 1, eligible: 0, stored: 0 });
  });

  it('keeps matchedTotal, returned, eligible, and stored distinct under a 200-row hard cap', () => {
    const results = Array.from({ length: 205 }, (_, index) => ({
      id: `https://openalex.org/W${index + 1}`,
      title: index === 199 ? '' : `Paper ${index + 1}`,
      publication_date: '2026-01-01',
      authors: ['A'],
    }));
    const batch = adaptLiteraturePresentation('search_openalex', {
      details: { total_count: 9_999, results },
    }, { source: 'full' });
    expect(batch).toMatchObject({
      matchedTotal: 9_999,
      returned: 205,
      inspected: 200,
      eligible: 199,
      stored: 20,
      inputCapped: true,
    });
    expect(JSON.stringify(batch).length).toBeLessThan(100_000);
  });
});

describe('paper candidate identity, conflicts, and dynamic library state', () => {
  it('merges only shared strong aliases, never title plus year', () => {
    const db = createTestDb();
    const service = new PresentationService(db);
    const first = adaptLiteraturePresentation('search_crossref', {
      details: { total_results: 1, items: [{ doi: '10.1000/shared', title: 'Shared title', authors: ['A'], published: [[2024]] }] },
    }, { source: 'full' })!;
    const shared = adaptLiteraturePresentation('search_openalex', {
      details: { total_count: 1, results: [{ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/shared', title: 'Conflicting title', publication_date: '2025-01-01', authors: ['B'] }] },
    }, { source: 'full' })!;
    const titleOnly = adaptLiteraturePresentation('search_openalex', {
      details: { total_count: 1, results: [{ id: 'https://openalex.org/W2', title: 'Shared title', publication_date: '2024-01-01', authors: ['C'] }] },
    }, { source: 'full' })!;
    appendBatch(service, 'search_crossref', first, { toolCallId: 'c1' });
    appendBatch(service, 'search_openalex', shared, { toolCallId: 'c2' });
    appendBatch(service, 'search_openalex', titleOnly, { toolCallId: 'c3' });

    const group = service.getRuns('session-a', ['run-a'])['run-a'].paperCandidates!;
    expect(group.unique).toBe(2);
    expect(group.shown).toBe(2);
    expect(group.candidates.find((candidate) => candidate.doi === '10.1000/shared')?.conflictingFields)
      .toEqual(expect.arrayContaining(['title', 'year', 'authors']));
  });

  it('does not make a title-only candidate actionable', () => {
    const batch = adaptLiteraturePresentation('search_crossref', {
      details: { total_results: 1, items: [{ title: 'No strong identity', authors: ['A'], published: [[2025]] }] },
    }, { source: 'full' })!;
    expect(batch.candidates[0]).toMatchObject({ actionable: false, strongAliases: [] });
  });

  it('enriches saved state by strong DOI/arXiv/provider identity without changing recordsRevision', () => {
    const db = createTestDb();
    const service = new PresentationService(db);
    const batch = adaptLiteraturePresentation('search_crossref', {
      details: { total_results: 1, items: [{ doi: '10.1000/saved', title: 'Saved paper', authors: ['A'], published: [[2025]] }] },
    }, { source: 'full' })!;
    appendBatch(service, 'search_crossref', batch);
    const before = service.getRuns('session-a', ['run-a'])['run-a'];
    expect(before.paperCandidates?.candidates[0].libraryId).toBeUndefined();
    db.prepare(`
      INSERT INTO rc_papers (id, title, authors, doi, added_at, updated_at)
      VALUES ('paper-1', 'Different title is irrelevant', '[]', '10.1000/SAVED', datetime('now'), datetime('now'))
    `).run();
    const after = service.getRuns('session-a', ['run-a'])['run-a'];
    expect(after.recordsRevision).toBe(before.recordsRevision);
    expect(after.paperCandidates?.candidates[0].libraryId).toBe('paper-1');
  });

  it('enforces a 100-candidate per-Run storage/view hard limit', () => {
    const db = createTestDb();
    const service = new PresentationService(db);
    for (let batchIndex = 0; batchIndex < 6; batchIndex += 1) {
      const payload = adaptLiteraturePresentation('search_openalex', {
        details: {
          total_count: 20,
          results: Array.from({ length: 20 }, (_, index) => ({
            id: `https://openalex.org/W${batchIndex * 20 + index + 1}`,
            title: `Paper ${batchIndex * 20 + index + 1}`,
            authors: ['A'],
          })),
        },
      }, { source: 'full', params: { query: `query-${batchIndex}` } })!;
      appendBatch(service, 'search_openalex', payload, { toolCallId: `batch-${batchIndex}` });
    }
    const run = service.getRuns('session-a', ['run-a'])['run-a'];
    expect(run.paperCandidates).toMatchObject({ stored: 100, unique: 100, shown: 3 });
    expect(run.paperCandidates?.candidates).toHaveLength(100);
    expect(run.paperBatches.at(-1)).toMatchObject({ stored: 0, runCapped: true });
  });
});
