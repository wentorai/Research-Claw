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
| 2. P0 authority/watchdog | complete | See below |
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

## Task 2 — P0 authority and watchdog demotion

Implementation facts:

- `sessions.list` rows now retain OC lifecycle fields and feed a single
  session-keyed reconciler with request-generation and event-epoch guards.
- `sessions.changed` is a partial fast path; only present fields merge, then a
  deduplicated complete Session query follows.
- command (`submitting/stopping`), lifecycle, activity and transport remain
  separate. The shared selector derives `serverActive/isBusy/canAbort/isStreaming`.
- composer Stop, TopBar, session activity dots and the current Run area consume
  that selector. A server-active Session remains stoppable without a local runId.
- the 360-second chat watchdog, the former 120-second tool heuristic and the
  former reconnect 15-second path can only request reconciliation. They cannot
  clear Run/tool state, finish TaskFlow, notify failure or write a timeout.
- a three-second abort timer no longer invents abort success; it requests Session
  reconciliation and keeps the Run identity until a terminal fact arrives.
- connect, session switch, visibility regain and sequence gaps trigger read-only
  reconciliation. Active/locally-busy sessions use one in-flight bounded poll
  with 15s → 30s → 60s backoff.

Test-first and integration evidence:

- Initial authority/watchdog suites failed because the central store did not
  exist; production code was added only after that red run.
- Task 2 targeted authority/watchdog: 2 files, 7 tests passed.
- Server-active-without-local-runId composer test proves session-level
  `chat.abort {sessionKey}` remains available after refresh-style state loss.
- Updated stale-stream compatibility tests prove reconnect age and quiet tools
  remain observations and do not terminate or evict anything.
- Full Dashboard parity: 37 files, 640 passed and 1 skipped.
- Dashboard TypeScript and production build passed. Vite reported only the
  repository's existing dynamic/static import and large-chunk warnings.

Deferred deliberately to Task 3: `sessionInfo/inFlightRun` hydration, ACK
uncertainty, pending-abort recovery, full terminal/new-generation fencing, and
duplicate/out-of-order frame suppression.
