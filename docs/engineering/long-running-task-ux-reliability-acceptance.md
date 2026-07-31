# Long-running task UX/reliability — implementation evidence

Branch baseline: `aa3d7ca9c3342e4cce5c2bcdd37a79b7ba8a80d8` (local RC `main` on 2026-07-31).

This is an evidence ledger for the P0/P1 implementation. It does not define a
second run lifecycle; the authoritative design remains the outer Wentor spec,
and runtime truth remains OpenClaw Session lifecycle plus its active-run
registry.

## Environment

- Locked OpenClaw package/source: `2026.6.1`.
- This machine has no `openclaw` conda environment. The repository startup
  script selects fnm Node `v22.22.2`, which is used for all commands here.
- The outer Wentor worktree and its untracked specifications are not modified.

## Task status

| Task | Status | Evidence |
|---|---|---|
| 1. OC state parity and fixtures | complete | See below |
| 2. P0 authority/watchdog | pending | — |
| 3. P1 recovery/races | pending | — |
| 4. UX/background guardrails | pending | — |

## Task 1 — OC state parity and fixtures

Observed locked OC sources:

- `ui/src/ui/session-run-state.ts` and its table tests;
- `src/gateway/session-lifecycle-state.ts` and tests;
- `src/gateway/server.sessions.list-changed.test.ts`;
- `src/gateway/server-chat.ts` lifecycle snapshots;
- `src/gateway/server-methods/chat.ts` history/send/abort contracts;
- `src/gateway/chat-abort.ts` active registry and `inFlightRun` projection;
- `ui/src/ui/controllers/sessions.ts` partial event merge and terminal fence.

Fixture facts:

- complete `sessions.list`/history rows carry `hasActiveRun`;
- lifecycle `sessions.changed` can omit it and must be merged as a partial row;
- `status=running + hasActiveRun=false` is inactive;
- terminal status wins over a contradictory active registry value;
- history may include `sessionInfo` plus `inFlightRun {runId,text}`;
- Chat terminal classification can arrive in top-level `stopReason/errorKind`.

Test-first evidence:

- Initial targeted run failed because `session-run-state` and
  `session-run-reconciler` did not exist (2 failed suites), before production
  implementation was added.
- RC targeted parity/reducer: 2 files, 19 tests passed.
- RC full parity directory: 35 files, 646 passed and 1 skipped.
- RC Dashboard TypeScript: passed (`tsc --noEmit`).
- Locked OC targeted contract suite: 5 files, 50 tests passed.

The first read-only call to the user's currently configured Gateway could not
establish a healthy 28789 connection. No live payload claim is made from that
attempt; live Gateway capture remains a required final integration acceptance
item.
