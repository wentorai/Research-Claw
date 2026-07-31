# Chat Evidence / Deliverable Card Contract Matrix

Status: Task 0 complete on 2026-07-31. Production adapters remain blocked until
Task 1/2 tests are written against these fixtures.

Runtime under test: OpenClaw `2026.6.1`, Node `v22.22.2`, real RC Core,
real `@wentorai/research-plugins`, real `research-superpower`, and an isolated
Gateway. A deterministic local model selected tools, but every tool execution
and hook/event payload came from the real runtime.

## Confirmed runtime facts

- `after_tool_call.event.result` is the OpenClaw-sanitized result. It is not
  described as raw anywhere in the implementation or UI.
- The full hook provides `sessionKey`, `runId`, and `toolCallId`. The persisted
  fallback provides `sessionKey` and `toolCallId`, but no `runId` or params.
- `tool_result_persist.event.isSynthetic` is present. Synthetic and missing-ID
  inputs must fail closed.
- One model-provided `toolCallId` was reused by normal, timeout, and cancelled
  Runs in three different sessions. `toolCallId` is not globally unique.
- Normal, queued, timeout, and cancelled chat ACKs, tool hooks, agent hooks, and
  chat events used the same Run identity. There was no Run alias in this probe.
- Projected `chat.history` preserves the user message idempotency key as
  `<runId>:user`, including timeout/cancel cases with no final assistant text.
  This is the refresh owner contract; no nearest-message heuristic is needed.
- The first real `before_prompt_build` had an empty `messages` array and a
  timestamp-enveloped prompt. It is not a stable copy of the original user
  message and must not be used as the user-turn join.
- The exact versioned stream `research-claw-core.presentation_changed` returned
  `{ emitted: true }` and reached a real Control UI WebSocket as an `agent`
  event. No `session.tool` timing fallback is required for supported 6.1.
- OC may emit a tool terminal event before the asynchronous `after_tool_call`
  projection completes. The custom event is emitted only after immutable
  records commit and therefore avoids a one-shot invalidation race.
- The pre-existing execution trace persisted only the first Run in the
  multi-session isolated probe; later queued Run resolver bindings were empty.
  Task 1 must repair the shared execution-details coordinator, not build a
  second card-only loader.

## Initial support matrix

| Tool | Full hook | Persisted path | Task 1/2 status |
|---|---|---|---|
| `workspace_save` | Real success | Real success + incident | Full candidate |
| `workspace_append` | Real success | Real success | Full candidate |
| `workspace_export` | Real xlsx success + real business error | Same | Full candidate |
| `workspace_download` | Real success + real HTTP business error | Same | Full candidate |
| `get_arxiv_paper` | Real positive result | Real positive result | Full candidate |
| `search_openalex` | Real positive result | Real untruncated + capped incident | Full candidate |
| `search_crossref` | Real positive result | Real untruncated + capped incident | Full candidate |
| `search_arxiv` | Real positive result | Real untruncated + capped incident | Full candidate |
| `search_dblp` | Real positive result | Real positive + incident zero-result | Full candidate |
| `rp_search` | Real positive array details | Real untruncated + capped/prefixed incident | Full candidate |
| `wentor-network__search_papers` | Full-hook retry blocked by real MCP catalog rate limit | Real incident success/error | Partial: persisted fallback only |

No generic tool-name pattern is allowed. Wentor full-hook events remain closed
until a positive full fixture is captured; its exact persisted incident shape
may be supported by the strict fallback adapter.

## Schema/count observations

- OpenAlex: `{ total_count, results, _source_health }`.
- Crossref: `{ total_results, items, _source_health }`.
- arXiv search: `{ total_results, papers, _source_health }`.
- arXiv get: one flat paper record.
- DBLP: `{ total_results, papers }`.
- `rp_search`: details are an array; persisted text has a diagnostic prefix
  followed by the JSON array.
- Wentor: `{ results, meta }`; its `paper_id` is provider identity, not a DOI.
- Incident capped examples retained matched totals separately from returned
  arrays: OpenAlex `3414/25`, arXiv `1738516/25`, Crossref `669341/25`, and
  `rp_search` returned 30. These are not stored/unique/shown counts.

## Fixture inventory

- `presentation-hooks-live-2026.6.1.json`: real positive full and persisted
  hooks for four workspace tools and six locally loaded literature tools.
- `presentation-incident-persisted-2026-07-31.json`: exact persisted incident
  records, including capped details and Wentor success/error.
- `presentation-lifecycle-events-live-2026.6.1.json`: normal/queued/timeout/
  cancel identities, projected history, resolver gap, and exact custom event.
- `presentation-negative-contracts-2026.6.1.json`: real business/thrown errors
  plus explicitly labelled derived missing/synthetic/malicious mutations.
- `scripts/verify-presentation-hook-contracts.mjs`: reproducible isolated live
  probe; it never writes checked-in fixtures automatically.

## Task evidence

Targeted parity command:

```bash
cd extensions/research-claw-core
pnpm exec vitest run src/__tests__/presentation-contracts.test.ts
```

Result at Task 0 completion: 12/12 passed. Full Core verification passed
1186 tests with 10 intentional skips across 50 files; the Core TypeScript build
also passed.

### Critical-thinking gate decisions

- All observations in this matrix are successful/error tool facts, not model
  relevance judgments.
- Paper semantics will be `retrieved` / “检索结果·尚未筛选”, never cited, saved,
  highlighted, or verified.
- Strong aliases are provider IDs, normalized DOI, and normalized arXiv IDs.
  Title/year is not a cross-source merge key.
- Full results and persisted/capped fallbacks are distinct completeness sources.
- Recovery truth is SQLite + session/run scope; events are invalidations only.
- The hard size limit and malicious field policy are production gates for Task 2.
- Removing every new prompt sentence must not affect projection reliability.
