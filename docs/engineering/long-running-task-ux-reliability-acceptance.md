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
| 3. P1 recovery/races | complete | See below |
| 4. UX/background guardrails | complete | See below |

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

## Task 3 — P1 refresh/reconnect recovery and races

Implementation facts:

- `chat.history` now consumes the real OC `sessionInfo` and `inFlightRun`
  projections. It restores accumulated text, the server runId and Stop on F5;
  an active Session without `inFlightRun` still restores generic running and a
  session-level Stop.
- History calls are fenced by normalized session key plus a per-key generation,
  covering the A → B → A late-response race. Accepted push events also invalidate
  same-epoch Session responses that were already in flight.
- `chat.send` normalizes the OC `started/in_flight/ok` ACK contract. A structured
  Gateway rejection is definitive and restores the draft; a timeout/socket close
  retains the exact payload and idempotency generation as `ack_unknown`, persists
  it across F5, performs read-only history/Session reconciliation, and never
  automatically replays the request.
- Matching history `idempotencyKey` or a matching `inFlightRun` resolves the
  unknown ACK. An empty snapshot or unrelated run does not prove rejection.
- Stop is stored once while offline, sent once per connection epoch after
  reconnect, and remains `stopping` until an OC terminal/non-active fact clears
  the pending command. No timer invents `killed`.
- Gateway event delivery now drops duplicate/out-of-order sequence numbers,
  reports real forward gaps, and resets the socket-scoped watermark on close so
  pre-hello broadcasts from a new connection remain valid.
- Chat terminal cause classification consumes top-level `stopReason/errorKind`;
  timeout is only recorded when explicit, user Stop maps to killed, and an
  otherwise unclassified abort remains interrupted.
- Terminal/new-generation runIds and sessionIds fence late events. Current-session
  tool projection cleanup no longer reacts to another Session's terminal.

Test-first and integration evidence:

- The first recovery run was deliberately red: 3 new suites, 10 failing tests
  (missing history hydration/generation guards, ACK handling and pending aborts).
- A separate Gateway ordering test first failed because duplicate and older frames
  were both dispatched; it passed after cursor filtering was implemented.
- Task 3 targeted integration: 13 files, 196 tests passed.
- Dashboard full parity: 41 files, 654 passed and 1 skipped. The first full run
  exposed a real cross-socket cursor regression in the pre-hello window; the
  isolated repro and the complete parity rerun both passed after moving the
  watermark reset to socket close.
- Dashboard TypeScript and production build passed. Vite emitted only the known
  import/chunk-size warnings.

The configured Gateway was still unavailable during this task-level check, so
live model/F5/restart/Stop evidence is not claimed here and remains a final
acceptance requirement.

## Task 4 — factual UX and background guardrails

Implementation facts:

- The inferred three-stage progress display and elapsed counter were removed
  from the current Run region. The region now projects transport, command,
  authoritative lifecycle and observed activity as separate inputs.
- Active Session truth shows a factual activity (`processing`, sanitized tool
  name, compaction, fallback or streaming) and tells the user they may wait or
  Stop. No-delta age, completion percentage and remaining-time estimates are
  not shown.
- `status=running + hasActiveRun=false` is displayed as a non-spinning result
  reconciliation state, not as running or failed. Disconnect/reconnect is
  displayed as transport recovery and never changes the task outcome.
- Locked OC's real `stream:lifecycle, data.phase:fallback` shape maps to fallback
  activity. Tool `end/result/error` events return the current activity to generic
  processing instead of leaving a completed tool shown as active. Tool labels
  discard namespaces, raw params and filesystem paths.
- An unclassified `chat:aborted` is now described as interrupted. Timeout text
  is used only when OC supplies `stopReason:errorKind=timeout`.
- Heuristic long-task detection may still offer the existing explicit Dashboard
  confirmation, but only explicit user background intent can bypass it. Runtime
  prompt/bootstrap guidance keeps inferred long work in the foreground; the
  Dashboard-confirmed `[Research-Claw] Auto Long Task` marker retains the
  existing Jobs/subagent route. No P2 migration system was added.

Test-first and integration evidence:

- Initial Task 4 red run covered the missing presentation helper, heuristic-only
  silent promotion and the old auto-background prompt. A second red run pinned
  the locked OC fallback payload and completed-tool activity transition.
- Task 4 Dashboard integration: 12 files, 161 tests passed. One first-run failure
  was an expected assertion-text drift after replacing the unsupported
  "generated reply" claim with "visible reply"; the corrected suite reran clean.
- Task 4 Dashboard TypeScript and production build passed, with only the known
  static/dynamic import and large-chunk warnings.
- Core plugin full suite: 48 files passed and 1 skipped; 1175 tests passed and 10
  skipped. Core plugin TypeScript build passed.

Cross-worktree note: the card-reliability worktree now also changes `App.tsx`,
`ChatView.tsx`, execution presentation and translations, and introduces a
`RunDetailsDock`/presentation owner. Final integration must reconcile ownership
of the single Run region semantically rather than accepting a textual merge.
