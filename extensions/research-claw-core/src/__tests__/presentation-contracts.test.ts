import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const readFixture = (name: string): Record<string, any> => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/${name}`, import.meta.url),
  'utf8',
));

const live = readFixture('presentation-hooks-live-2026.6.1.json');
const incident = readFixture('presentation-incident-persisted-2026-07-31.json');
const lifecycle = readFixture('presentation-lifecycle-events-live-2026.6.1.json');
const negative = readFixture('presentation-negative-contracts-2026.6.1.json');

const fullHookTools = [
  'workspace_save',
  'workspace_append',
  'workspace_export',
  'workspace_download',
  'get_arxiv_paper',
  'search_openalex',
  'search_crossref',
  'search_arxiv',
  'search_dblp',
  'rp_search',
];

function persistedText(entry: Record<string, any>): string {
  return entry.persistedTranscriptRecord.message.content.find(
    (part: Record<string, unknown>) => part.type === 'text',
  )?.text ?? '';
}

describe('presentation contracts captured from OpenClaw 2026.6.1', () => {
  it('keeps an explicit full-hook matrix instead of accepting a generic JSON shape', () => {
    expect(Object.keys(live.cases)).toEqual(fullHookTools);
    expect(live.cases).not.toHaveProperty('wentor-network__search_papers');

    for (const toolName of fullHookTools) {
      const fixture = live.cases[toolName];
      expect(fixture.before_tool_call.event.toolName).toBe(toolName);
      expect(fixture.after_tool_call.event.toolName).toBe(toolName);
      expect(fixture.after_tool_call.event.runId).toBe(fixture.after_tool_call.context.runId);
      expect(fixture.after_tool_call.event.toolCallId).toBe(
        fixture.before_tool_call.event.toolCallId,
      );
      expect(fixture.tool_result_persist.event.toolCallId).toBe(
        fixture.after_tool_call.event.toolCallId,
      );
      expect(fixture.tool_result_persist.context.sessionKey).toBe(
        fixture.after_tool_call.context.sessionKey,
      );
      // This is the real fallback constraint: persisted hooks have no Run identity.
      expect(fixture.tool_result_persist.event).not.toHaveProperty('runId');
      expect(fixture.tool_result_persist.context).not.toHaveProperty('runId');
      expect(fixture.tool_result_persist.event.isSynthetic).toBe(false);
    }
  });

  it('captures stable user-turn Run identity in before_prompt_build context', () => {
    const promptBuild = live.promptLifecycle.find(
      (entry: Record<string, any>) => entry.kind === 'before_prompt_build',
    );
    expect(promptBuild.context.runId).toBe('presentation-contract-run-1');
    expect(promptBuild.context.sessionKey).toBe('agent:main:presentation-contract-1');
    expect(promptBuild.event).not.toHaveProperty('runId');
    expect(promptBuild.event.messages).toEqual([]);
    expect(promptBuild.event.prompt).toContain('RC_CONTRACT_TOOL_CALL');
    expect(promptBuild.event.prompt).toContain('workspace_save');
  });

  it('preserves exact success details for all four workspace tools', () => {
    expect(live.cases.workspace_save.after_tool_call.event.result.details).toMatchObject({
      path: 'outputs/contracts/base.csv',
      size: 24,
      committed: false,
    });
    expect(live.cases.workspace_append.after_tool_call.event.result.details).toMatchObject({
      path: 'outputs/contracts/base.csv',
      size: 38,
      committed: false,
    });
    expect(live.cases.workspace_export.after_tool_call.event.result.details).toMatchObject({
      source: 'outputs/contracts/base.csv',
      output: 'outputs/contracts/base.xlsx',
      format: 'xlsx',
      committed: false,
    });
    expect(live.cases.workspace_download.after_tool_call.event.result.details).toMatchObject({
      path: 'outputs/contracts/example.html',
      size: 559,
      committed: false,
      source_url: 'https://example.com/',
    });
  });

  it('pins each literature provider schema and does not let one OpenAlex result mask gaps', () => {
    expect(Object.keys(live.cases.get_arxiv_paper.after_tool_call.event.result.details)).toEqual(
      expect.arrayContaining(['arxiv_id', 'title', 'authors', 'pdf_url', 'abs_url']),
    );
    expect(live.cases.search_openalex.after_tool_call.event.result.details).toEqual(
      expect.objectContaining({ total_count: expect.any(Number), results: expect.any(Array) }),
    );
    expect(live.cases.search_crossref.after_tool_call.event.result.details).toEqual(
      expect.objectContaining({ total_results: expect.any(Number), items: expect.any(Array) }),
    );
    expect(live.cases.search_arxiv.after_tool_call.event.result.details).toEqual(
      expect.objectContaining({ total_results: expect.any(Number), papers: expect.any(Array) }),
    );
    expect(live.cases.search_dblp.after_tool_call.event.result.details).toEqual(
      expect.objectContaining({ total_results: expect.any(Number), papers: expect.any(Array) }),
    );
    expect(live.cases.rp_search.after_tool_call.event.result.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: expect.any(String) })]),
    );
  });

  it('proves persisted details can be capped while recoverable content retains returned rows', () => {
    const expectations: Record<string, { totalKey: string; rowsKey?: string; returned: number }> = {
      search_openalex: { totalKey: 'total_count', rowsKey: 'results', returned: 25 },
      search_arxiv: { totalKey: 'total_results', rowsKey: 'papers', returned: 25 },
      search_crossref: { totalKey: 'total_results', rowsKey: 'items', returned: 25 },
      rp_search: { totalKey: '', returned: 30 },
    };
    for (const [toolName, expected] of Object.entries(expectations)) {
      const entry = incident.capped[toolName];
      const message = entry.persistedTranscriptRecord.message;
      const text = persistedText(entry);
      expect(message.details).toMatchObject({
        persistedDetailsTruncated: true,
        originalDetailsBytesAtLeast: 8193,
      });
      expect(createHash('sha256').update(text).digest('hex')).toBe(entry.contentEvidence.sha256);
      const jsonText = toolName === 'rp_search'
        ? text.slice(text.indexOf('\n[') + 1)
        : text;
      const payload = JSON.parse(jsonText);
      if (expected.rowsKey) {
        expect(payload[expected.totalKey]).toBeGreaterThan(expected.returned);
        expect(payload[expected.rowsKey]).toHaveLength(expected.returned);
      } else {
        expect(payload).toHaveLength(expected.returned);
      }
    }
  });

  it('classifies Wentor as persisted-only partial support with separate success and error facts', () => {
    const success = incident.persistedOnly.wentor_network_success;
    const payload = JSON.parse(persistedText(success));
    expect(success.persistedTranscriptRecord.message.toolName).toBe(
      'wentor-network__search_papers',
    );
    expect(success.persistedTranscriptRecord.message.isError).toBe(false);
    expect(payload).toEqual(expect.objectContaining({
      results: expect.any(Array),
      meta: expect.any(Object),
    }));
    expect(payload.results).toHaveLength(25);

    const error = incident.persistedOnly.wentor_network_error.persistedTranscriptRecord.message;
    expect(error.isError).toBe(true);
    expect(error.details).toEqual(expect.objectContaining({ status: 'error' }));
  });

  it('keeps thrown errors, business errors, and derived hostile cases distinguishable', () => {
    const exportError = negative.real.workspace_export_business_error.after_tool_call.event;
    expect(exportError.error).toBeUndefined();
    expect(exportError.result.details.error).toContain('pandoc');

    const mcpError = negative.real.wentor_mcp_catalog_error.after_tool_call.event;
    expect(mcpError.error).toBe('Tool wentor-network__search_papers not found');

    expect(negative.derived.missing_tool_call_id.event.toolCallId).toBeUndefined();
    expect(negative.derived.missing_tool_call_id.context.toolCallId).toBeUndefined();
    expect(negative.derived.synthetic_tool_result.event.isSynthetic).toBe(true);
    expect(negative.derived.malicious_fields.event.result.details.path).toContain('..');
    expect(negative.derived.malicious_fields.event.result.details.url).toMatch(/^javascript:/);
  });
});

describe('real lifecycle, resolver, and custom event contracts', () => {
  it('uses one canonical Run identity for ACK, hook, chat, normal, queued, timeout, and cancel', () => {
    const cases = lifecycle.lifecycle.cases;
    for (const [runId, entry] of Object.entries(cases) as Array<[string, Record<string, any>]>) {
      expect(entry.requestedRunId).toBe(runId);
      expect(entry.acknowledgedRunId).toBe(runId);
      expect(entry.after_tool_call.event.runId).toBe(runId);
      expect(entry.after_tool_call.context.runId).toBe(runId);
      expect(entry.agent_end.event.runId).toBe(runId);
      const runFrames = lifecycle.lifecycle.chatAndAgentFrames.filter(
        (frame: Record<string, any>) => frame.payload?.runId === runId,
      );
      expect(runFrames.length).toBeGreaterThan(0);
      expect(runFrames.every((frame: Record<string, any>) => frame.payload.runId === runId)).toBe(true);
    }
    expect(cases['presentation-lifecycle-run-timeout'].agent_end.event.success).toBe(false);
    expect(cases['presentation-lifecycle-run-cancelled'].agent_end.event.success).toBe(false);
    expect(cases['presentation-lifecycle-run-normal'].agent_end.event.success).toBe(true);
  });

  it('proves toolCallId is not globally unique and persisted fallback has to include sessionKey', () => {
    const cases = lifecycle.lifecycle.cases;
    for (const runId of [
      'presentation-lifecycle-run-normal',
      'presentation-lifecycle-run-timeout',
      'presentation-lifecycle-run-cancelled',
    ]) {
      expect(cases[runId].after_tool_call.event.toolCallId).toBe('contract-reused-tool-call');
    }
    expect(new Set([
      cases['presentation-lifecycle-run-normal'].sessionKey,
      cases['presentation-lifecycle-run-timeout'].sessionKey,
      cases['presentation-lifecycle-run-cancelled'].sessionKey,
    ]).size).toBe(3);
  });

  it('records the pre-existing resolver gap as a blocking Task 1 contract', () => {
    expect(lifecycle.lifecycle.resolver.normal.bindings).toEqual([
      { index: 0, runId: 'presentation-lifecycle-run-normal' },
    ]);
    expect(lifecycle.lifecycle.resolver.queued.bindings).toEqual([]);
    expect(lifecycle.provenance.observedGap).toContain('Only the first run');
  });

  it('preserves the authoritative chat-send Run id on user turns after history projection', () => {
    const histories = lifecycle.lifecycle.histories;
    const expectedRuns = [
      'presentation-lifecycle-run-normal',
      'presentation-lifecycle-run-queued-a',
      'presentation-lifecycle-run-queued-b',
      'presentation-lifecycle-run-timeout',
      'presentation-lifecycle-run-cancelled',
    ];
    const userKeys = Object.values(histories)
      .flatMap((history: any) => history.messages)
      .filter((message: Record<string, unknown>) => message.role === 'user')
      .map((message: Record<string, unknown>) => message.idempotencyKey);
    expect(userKeys).toEqual(expectedRuns.map((runId) => `${runId}:user`));
  });

  it('delivers the exact versioned plugin-owned event stream to a real Dashboard socket', () => {
    expect(lifecycle.customEvent.emission.event.emitted).toEqual({
      emitted: true,
      stream: 'research-claw-core.presentation_changed',
    });
    expect(lifecycle.customEvent.deliveredFrame).toMatchObject({
      type: 'event',
      event: 'agent',
      payload: {
        runId: 'presentation-contract-run-1',
        sessionKey: 'agent:main:presentation-contract-1',
        stream: 'research-claw-core.presentation_changed',
        data: { schemaVersion: 1, recordsRevision: 1 },
      },
    });
  });
});
