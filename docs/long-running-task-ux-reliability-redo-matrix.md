# Long-running task reliability redo — coverage matrix

Date: 2026-08-01
Branch: `codex/rc-longrun-ux-reliability`
Authority: `docs/research-claw/2026-07-31-long-running-task-ux-reliability-spec.md`

This matrix is a release gate, not a progress estimate. An item is complete
only when its fixture/test, implementation, and real acceptance evidence all
exist. No item may be waived because a broader suite passes.

## Trace contract

Manual acceptance runs use the opt-in `rc-run-trace` probe. It records only:

- `sessionKey`, `sessionId`, `runId`;
- `requestGeneration`, `eventEpoch`, frame `seq`;
- Session `status`, `hasActiveRun`, `startedAt`, `endedAt`;
- command/lifecycle decisions and field-presence metadata.
- confirmed `chat.abort` receipt decisions (`aborted/runIds` field names only).

It never records user messages, model output, tool arguments, file paths,
provider error bodies, configuration, or secrets. The probe is disabled by
default and keeps at most 2,000 in-memory entries.

Enable with `?rc-run-trace=1`. Export in the browser console with:

```js
JSON.stringify(window.__RC_RUN_TRACE__.snapshot(), null, 2)
```

## Mandatory defect coverage

| ID | Exposed defect / contract | Failing fixture or automated test gate | Required trace evidence | Real acceptance gate |
|---|---|---|---|---|
| LR-01 | Previous `done/killed/timeout` snapshot is attributed to a new ACK generation | Previous terminal → local start → ACK started → no-runId stale `sessions.list` terminal; new localRunId must survive | local-send, send-ack, reconcile request/response/applied with generation | Send immediately after completed and stopped runs; first-frame state must be submitting/processing, never previous terminal |
| LR-02 | Immediate state differs from F5 recovery | Live path and `chat.history(sessionInfo,inFlightRun)` must converge on the same generation | pre-F5 trace plus post-F5 history response with inFlightRun | F5 during a 180s foreground run; wording and Stop capability remain consistent |
| LR-03 | Same-session queued runs and repeated send | Two sequential idempotency keys with delayed lifecycle start; old terminal cannot clear the queued generation | both runIds and their accepted/ignored decisions | Stop a run and immediately send `SESSION_B_OK`; no false stopped/completed/timeout |
| LR-04 | Late/duplicate/out-of-order terminal events | `final(done)` → duplicate final → late aborted/running for same and old run; done is absorbing | frame seq/eventEpoch and reducer decision | Complete a run while reconnecting; no later interruption banner or spinner resurrection |
| LR-05 | False “本次运行可能已中断” | Old-run `chat:aborted` after local runId cleanup/F5 must not write chat `lastError` | chat event candidate plus central terminal decision | Successful background dispatch and foreground completion must not show interruption warning |
| LR-06 | User Stop shown as timeout/runtime limit | `stopReason=rpc` killed followed by coarse timeout snapshot and F5 must preserve the server-confirmed Stop cause; `aborted:false`/unknown must not invent it | abort response, terminal cause, later snapshot projection decision | Stop at <60s, wait for any late terminal, then F5; UI is idle/stopped, never error/time limit |
| LR-07 | `running + hasActiveRun=false` confirms forever | Repeated conflict snapshots must stop after 5s or two queries and settle non-active unknown | exactly bounded reconcile attempts | Gateway restart mismatch; no indefinite spinner/poll loop |
| LR-08 | 207s/360s without chat delta | Server-active snapshot over both thresholds must remain running; watchdog only reconciles | stale-watchdog reason followed by active Session truth | Real long tool run with no assistant delta; no failure/timeout |
| LR-09 | ACK unknown and restart uncertainty | No automatic replay after connection identity uncertainty; exact idempotency evidence adopts active/completed run | ack_unknown, conn epoch, history evidence | Disconnect during submit and reconnect/restart; no duplicate user run |
| LR-10 | A/B/A session switch and late response | Per-session request generation; late A/B history and events cannot overwrite current session | distinct session keys/generations | Rapid A→B→A with one active Run in each |
| LR-11 | WebSocket gap, reconnect and duplicate frames | Epoch bump precedes gap frame; stale epoch/seq ignored; authoritative resync wins | seq-gap, transport, hello, history/reconcile | Disconnect/reconnect and simulated Gateway restart |
| LR-12 | Stop without local runId | Server-active Session keeps Stop enabled and aborts by sessionKey | abort request and reconciliation without runId | F5 during active run, then Stop |
| BG-01 | Heuristic modal has no “do not send” | Three explicit outcomes: background, foreground, cancel/no RPC | decision only; no prompt content | Each modal action produces exactly its labelled effect |
| BG-02 | Regex mistakes mention for explicit intent | Negative cases such as “后台任务为什么失败？” and discussion/questions must not silently dispatch | detector reasons/decision | Discuss background Jobs without spawning anything |
| BG-03 | Bulk workspace/report sentence over-classified | The exposed sentence must stay foreground with no modal; only a separate request containing an explicit duration signal plus broad concrete action may ask | detector score and decision | Exposed sentence sends foreground; exercise all three modal choices on a deliberately long/broad request |
| BG-04 | Opt-out is not respected | “请不要后台化…” always remains foreground | detector opt-out decision | 180s foreground run stays in current Session |
| BG-05 | Runtime `process.poll >15s` hook forces an explicitly foreground Run toward a Job and can duplicate the command | Exact 2026-08-01 foreground poll/block/duplicate-exec fixture; RC must defer to OC’s bounded poll contract and forbid re-launch while process is active | existing process Session remains the only execution | Foreground `sleep` remains one OC Run/one shell process and never creates a Job |
| JOB-01 | Top and per-card refresh are ambiguous/no-feedback | One documented refresh scope; visible loading/success/failure/last-updated behavior | jobs refresh start/result | User can explain what refresh changed; no redundant card reload icons |
| JOB-02 | Jobs drawer exposes contradictory/raw states | User-facing hierarchy and translated status/error; aggregate/worker relation is clear | job ids/status transitions | Completed aggregate and stalled/cancelled worker are not presented as unexplained peers |
| JOB-03 | Background count is on far right | Component test asserts count follows heartbeat before flexible spacer | n/a | Visual check at 28789 |
| JOB-04 | Cancelled Job resurrects to completed | `cancelled` is absorbing against late checkpoint/sync/`job_finish` unless explicit user retry creates a new attempt | cancelled → late finish decision | Cancel a live child; it remains cancelled even if worker reports late completion |
| JOB-05 | Cancel UI promises more than backing abort | Cancel result distinguishes durable Job cancellation from backing-run stop uncertainty | cancellation outcome metadata | Failed best-effort backing abort is disclosed without reviving the Job |
| JOB-06 | OC returns a CLI task before the authoritative subagent wrapper for the same Run | Exact 2026-08-01 dual-record `tasks.list` fixture; Stop must select the wrapper and require `cancelled=true` | selected task id/runtime plus exact cancel result | Real `sleep 120` child: wrapper cancelled, CLI aborted, child `hasActiveRun=false` before success is shown |
| JOB-07 | A cancelled child completion announce silently restarts or foreground-continues work | Completion prompt must query `job_status`; cancelled is absorbing and prohibits resume/replacement/foreground continuation | one `job_status` call and no execution tool after cancelled result | Gateway restart of a previously cancelled Job produces a stop acknowledgement only |
| JOB-08 | A completed child announcement revives a different, previously aborted user request from the same transcript | Exact 2026-08-01 parent transcript fixture: aborted paper request → unrelated Auto Long Task → OC completion prompt containing generic “original task”; completion guidance must bind to the exact latest Job ID | exact Job ID boundary, one `job_status`, no duplicate `job_finish`, no unrelated tool | Stop foreground `sleep 90`, dispatch background `sleep 5`, then require only the child result; old command/request must not resume |
| TF-01 | TaskFlow is a global current-session projection | Flow/activity is keyed or strictly fenced by session/run; switch cannot show another Session’s flow | sessionKey/runId on flow decisions | Active A/B switching never leaks stages |
| TF-02 | Foreground tool stream is global even though TaskFlow was isolated | Exact Run A `process` event followed by empty Session B selection; pending tool selector and clear operation must be keyed | A/B session key on every pending tool | Empty B shows no A tool; starting/finishing B cannot erase A tool state |
| TF-03 | Lower-specificity agent `item` events overwrite an already observed concrete `tool` activity | Real OC event ordering fixture: tool start followed by item start; partial item event must not erase the tool observation | activity decision records ignored partial item and retained tool name | During real `process` polling, UI remains “正在使用 process” instead of regressing to generic processing |

## Captured real acceptance evidence

| Date/time | Case | OC truth observed | Dashboard result |
|---|---|---|---|
| 2026-08-01 03:44 CST | JOB-06 real background Stop | Pre-stop `tasks.list` returned CLI `b789…` first and subagent wrapper `1b47…` second for Run `9ceb…`; post-stop wrapper=`cancelled`, CLI=`timed_out` with `terminalSummary=aborted`, child Session `hasActiveRun=false` | Success toast shown only after wrapper cancellation; Job remained “已取消” |
| 2026-08-01 03:44 CST | JOB-07 completion announce | Parent announce Run called `job_status` once, observed Job `longtask:377a…` cancelled, then terminated without respawn or foreground work | Final message: “已停止，未恢复执行”；F5 remained idle/cancelled |
| 2026-08-01 03:46 CST | BG-05 foreground poll policy (pre-fix failure) | Run `3ed9…` started `sleep 420`, RC blocked `process.poll(timeout=430000)`, then the model launched a second `sleep 420` | Correctly recorded as acceptance failure; failing tests added before removing the RC override |
| 2026-08-01 03:51 CST | TF-02 A→B switch (pre-fix failure) | A Run `3ed9…` remained server-active; B was a new empty Session `project-9a918028` | B incorrectly rendered A’s pending `process` rows; recorded as acceptance failure before session-keying the tool stream |
| 2026-08-01 03:50–03:53 CST | LR-02/LR-08/LR-10 | F5 recovered Run `3ed9…` through `inFlightRun`; at ~372s stale reconciliation returned `running + hasActiveRun=true`; B Run `3d5a…` completed independently; A later ended `done` at 445,046ms | A stayed running with Stop, no timeout/interruption; B late response did not overwrite A; A completion survived F5 |
| 2026-08-01 04:04 CST | BG-05 post-fix single process | Foreground Run `4d329939…` executed exactly one `sleep 90`, then three OC-bounded `process.poll` calls; transcript `7287a5f8…` ended `done` with `FOREGROUND_SINGLE_PROCESS_OK` | One foreground Run, no detached Job, no duplicate exec, no RC poll guard |
| 2026-08-01 04:08 CST | TF-03 activity specificity | A real tool start was followed by OC `item` start on the same Run; before the fix the UI regressed to generic processing | After fixing partial-event merge, Session `project-28379749` remained “正在使用 process” / “工具运行中” |
| 2026-08-01 04:10 CST | LR-10 / TF-02 post-fix A/B isolation | A stayed server-active while a new empty B Session `project-f153351d` was selected; B had no Run or tool activity | Empty B was idle with no Stop and no A process row; returning to A recovered its correct result |
| 2026-08-01 04:13 CST | LR-02 / LR-12 F5 then Stop | F5 history returned the same in-flight Run for Session `project-0b14dd2d`; session-key Stop produced terminal `killed`; a later stale `running + false` snapshot arrived | Stop remained available after F5; UI converged to stopped/idle and the late snapshot did not resurrect a spinner or timeout |
| 2026-08-01 04:17 CST | LR-07 / LR-11 Gateway restart | Restart interrupted active Run `8b14161a…`; post-restart OC returned `status=running + hasActiveRun=false` | First run exposed a stuck confirmation cadence; after the fix, current-epoch 1s/2s reconciliation settled to non-active “运行结果尚未确认”, with no false failure or endless spinner |
| 2026-08-01 04:19 CST | BG-03 / BG-01 intent UX | Exact ordinary bulk-paper sentence had no explicit duration/background signal; separate 2-hour/100-paper sentence met narrow suggestion gate | Ordinary sentence sent foreground; deliberate long request showed exactly “取消发送 / 前台执行 / 后台执行”; cancel restored the exact draft and sent no RPC |
| 2026-08-01 04:20 CST | JOB-01 / JOB-03 Jobs UX | Explicit background Job spawned a real OC child and updated the durable Job | Status count rendered immediately after heartbeat; drawer had one “刷新全部” control with success feedback and one merged Job after reconciliation |
| 2026-08-01 04:21 CST | JOB-08 pre-fix failure | Parent Session `2b831ea9…` received completion for sleep Job `longtask:eeda…`, then revived an earlier aborted paper request and called 23 unrelated tools | Recorded as acceptance failure; exact parent transcript/OC completion prompt converted into a fixture before the boundary fix |
| 2026-08-01 04:27–04:28 CST | JOB-08 post-fix | Parent Session `a8f8712c…`: old `sleep 90` Run was aborted; new child Session `50493fd4…` completed Job `longtask:ef422…`; announcement Run queried that exact Job once and observed terminal completed | Parent replied only `BOUNDARY_JOB_OK`; no duplicate `job_finish`, no repeated old exec, and no unrelated workspace/library tool |

## Observed OpenClaw process-stop boundary

OC 2026.6.1 intentionally preserves an exec process after it has auto-yielded
into a pollable process Session, even if the parent tool/run abort signal later
fires (`bash-tools.exec.background-abort.test.ts`). In the JOB-08 acceptance,
the stopped foreground Run's `sleep 90` had already auto-yielded as
`ember-willow`; the next Agent turn observed and killed that stale process
before starting new work. The current P0 spec defines Stop as `chat.abort` of
the OC Run and does not specify process-registry cancellation. RC therefore
does not invent a second process-control truth or claim that `chat.abort`
proves every yielded OS process is dead. This remains an explicit upstream
semantic risk for commands that auto-yield; it is not hidden by the UI tests.

## Test and acceptance gates

Before handoff, all rows above must have evidence and the following must pass:

1. targeted parity/unit/component tests for every row;
2. Dashboard related integration tests and full suite;
3. Dashboard production build;
4. RC plugin test and build;
5. at least one real OC/RC model run, including a real foreground long tool run;
6. browser acceptance on this worktree’s RC service after port 28789 is free;
7. manual checklist delivered to the user, followed by an explicit wait for
   “手工验收通过，可以合并”.

## Runtime environment evidence

The host did not contain the documented conda `openclaw` environment during
final acceptance. Both `/Users/liusiyuan/anaconda3/bin/conda env list` and the
installed Claude Science micromamba environment list were checked; an explicit
`run -n openclaw` returned `EnvironmentLocationNotFound`. No replacement
environment was created because that would change host state outside this
task. The repository launcher, all tests, E2E verification, and builds ran with
Node `v22.22.2`, and the launcher printed that exact runtime at startup.
