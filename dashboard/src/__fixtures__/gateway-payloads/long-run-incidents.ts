/**
 * Long-run incident sequence from the 2026-08-01 manual acceptance session.
 *
 * Identity/timestamps come from:
 *   ~/.openclaw/agents/main/sessions/
 *   43b6e689-c1f0-42b2-ae3a-f24ff666d3a4.jsonl
 *
 * Wire-field presence follows locked OC 2026.6.1:
 *   - src/gateway/server-methods/chat.ts (ACK + chat.history)
 *   - src/gateway/server-methods/sessions.ts (sessions.list)
 *   - src/gateway/chat-abort.ts (chat aborted with stopReason)
 *
 * The original browser WS frames were not retained. These fixtures therefore
 * reconstruct the observed race from the real transcript identities and the
 * exact OC wire schema; they must be supplemented by an opt-in run-trace
 * capture during final acceptance.
 */

export const INCIDENT_SESSION_KEY = 'agent:main:project-d1921f34';
export const INCIDENT_SESSION_ID = '43b6e689-c1f0-42b2-ae3a-f24ff666d3a4';

export const INCIDENT_LONG_420_RUN_ID = 'b6bd2810-d031-4efa-b940-1dbf4db215e4';
export const INCIDENT_SESSION_B_RUN_ID = '9a6d2fba-cbbc-4814-9443-05e63732e24f';
export const INCIDENT_SLEEP_180_RUN_ID = 'dd911d22-156e-48ae-b846-62b2e9782917';
export const INCIDENT_BACKGROUND_PARENT_RUN_ID = 'b3194e88-4e4e-4317-95fd-9c14c156901d';
export const INCIDENT_SLEEP_300_RUN_ID = 'ed8ba1ae-6182-408f-9a78-bb5df862f6a2';

export const INCIDENT_ACK_STARTED = {
  runId: INCIDENT_SLEEP_180_RUN_ID,
  status: 'started',
} as const;

/** Previous SESSION_B completion racing with the new sleep-180 ACK. */
export const INCIDENT_STALE_DONE_AFTER_NEW_ACK = {
  sessions: [
    {
      key: INCIDENT_SESSION_KEY,
      sessionId: INCIDENT_SESSION_ID,
      status: 'done',
      hasActiveRun: true,
      startedAt: 1_785_516_617_705,
      endedAt: 1_785_516_677_727,
      runtimeMs: 60_022,
      updatedAt: 1_785_516_677_727,
    },
  ],
} as const;

/** Previous explicit Stop racing with the next same-session send. */
export const INCIDENT_STALE_KILLED_AFTER_NEW_ACK = {
  sessions: [
    {
      key: INCIDENT_SESSION_KEY,
      sessionId: INCIDENT_SESSION_ID,
      status: 'killed',
      hasActiveRun: true,
      startedAt: 1_785_516_469_801,
      endedAt: 1_785_516_616_689,
      runtimeMs: 146_888,
      updatedAt: 1_785_516_616_689,
    },
  ],
} as const;

/** A coarse persisted timeout row has no stopReason/runId provenance. */
export const INCIDENT_COARSE_TIMEOUT_SNAPSHOT = {
  sessions: [
    {
      key: INCIDENT_SESSION_KEY,
      sessionId: INCIDENT_SESSION_ID,
      status: 'timeout',
      hasActiveRun: false,
      startedAt: 1_785_516_695_990,
      endedAt: 1_785_516_720_844,
      runtimeMs: 24_854,
      updatedAt: 1_785_516_720_844,
    },
  ],
} as const;

export const INCIDENT_RPC_STOP_EVENT = {
  runId: INCIDENT_SLEEP_180_RUN_ID,
  sessionKey: INCIDENT_SESSION_KEY,
  state: 'aborted',
  stopReason: 'rpc',
} as const;

export const INCIDENT_LATE_OLD_ABORT_EVENT = {
  runId: INCIDENT_SLEEP_180_RUN_ID,
  sessionKey: INCIDENT_SESSION_KEY,
  state: 'aborted',
  stopReason: 'rpc',
} as const;

export const INCIDENT_SLEEP_300_HISTORY_ACTIVE = {
  messages: [
    {
      role: 'user',
      timestamp: 1_785_516_697_314,
      idempotencyKey: `${INCIDENT_SLEEP_300_RUN_ID}:user`,
    },
  ],
  sessionInfo: {
    key: INCIDENT_SESSION_KEY,
    sessionId: INCIDENT_SESSION_ID,
    status: 'running',
    hasActiveRun: true,
    startedAt: 1_785_516_697_314,
    updatedAt: 1_785_516_758_000,
  },
  inFlightRun: {
    runId: INCIDENT_SLEEP_300_RUN_ID,
    text: '',
  },
} as const;

export const INCIDENT_RUNNING_WITHOUT_ACTIVE = {
  sessions: [
    {
      key: INCIDENT_SESSION_KEY,
      sessionId: INCIDENT_SESSION_ID,
      status: 'running',
      hasActiveRun: false,
      startedAt: 1_785_516_697_314,
      updatedAt: 1_785_517_017_000,
    },
  ],
} as const;

/**
 * Exact Stop → killed → late timeout → F5 sequence captured by the opt-in
 * Dashboard run trace on 2026-08-01. Unlike the reconstructed fixtures above,
 * these are retained wire payloads from the final-acceptance browser session.
 *
 * The OC transcript persists the user idempotency key and a generic aborted
 * prompt error, but does not retain stopReason:"rpc". The chat.abort RPC
 * contract returns `{ aborted, runIds }`; that confirmed command receipt is
 * therefore the only durable causal evidence RC can retain without creating a
 * second lifecycle store.
 */
export const ACCEPTANCE_STOP_SESSION_KEY = 'agent:main:project-d254ab8b';
export const ACCEPTANCE_STOP_SESSION_ID = 'f5db192f-58fc-47f7-9024-385b3d632d52';
export const ACCEPTANCE_STOP_RUN_ID = '033355d1-2955-4433-bbb7-5a8597890e2a';

export const ACCEPTANCE_STOP_COMMAND_CONFIRMED = {
  sessionKey: ACCEPTANCE_STOP_SESSION_KEY,
  runId: ACCEPTANCE_STOP_RUN_ID,
  requestedAt: 1_785_523_623_558,
  confirmedAt: 1_785_523_623_572,
} as const;

export const ACCEPTANCE_RPC_STOP_EVENT = {
  runId: ACCEPTANCE_STOP_RUN_ID,
  sessionKey: ACCEPTANCE_STOP_SESSION_KEY,
  seq: 7,
  state: 'aborted',
  stopReason: 'rpc',
} as const;

export const ACCEPTANCE_KILLED_SESSION_EVENT = {
  key: ACCEPTANCE_STOP_SESSION_KEY,
  sessionId: ACCEPTANCE_STOP_SESSION_ID,
  runId: ACCEPTANCE_STOP_RUN_ID,
  status: 'killed',
  startedAt: 1_785_523_566_174,
  endedAt: 1_785_523_623_562,
} as const;

export const ACCEPTANCE_LATE_TIMEOUT_SESSION_EVENT = {
  key: ACCEPTANCE_STOP_SESSION_KEY,
  sessionId: ACCEPTANCE_STOP_SESSION_ID,
  runId: ACCEPTANCE_STOP_RUN_ID,
  status: 'timeout',
  startedAt: 1_785_523_566_174,
  endedAt: 1_785_523_625_865,
} as const;

export const ACCEPTANCE_F5_TIMEOUT_HISTORY = {
  messages: [
    {
      role: 'user',
      timestamp: 1_785_523_567_180,
      idempotencyKey: `${ACCEPTANCE_STOP_RUN_ID}:user`,
    },
    {
      role: 'assistant',
      content: [],
      stopReason: 'aborted',
      errorMessage: 'This operation was aborted',
      timestamp: 1_785_523_625_861,
    },
  ],
  sessionInfo: {
    key: ACCEPTANCE_STOP_SESSION_KEY,
    sessionId: ACCEPTANCE_STOP_SESSION_ID,
    status: 'timeout',
    hasActiveRun: false,
    startedAt: 1_785_523_566_174,
    endedAt: 1_785_523_625_865,
    runtimeMs: 59_691,
  },
} as const;

/**
 * Exact `tasks.list` payload captured before stopping a real background
 * `sleep 120` child on 2026-08-01. OC exposes two control records for one
 * subagent run and returns the CLI record first. Cancelling only that first
 * record does not stop the subagent wrapper.
 */
export const ACCEPTANCE_JOB_STOP_JOB_ID =
  'longtask:377aaa6f-30e0-41a1-9894-56e56b8a2f47';
export const ACCEPTANCE_JOB_STOP_CHILD_SESSION_KEY =
  'agent:main:subagent:16659d47-c2a7-4875-9886-201f2c922aaa';
export const ACCEPTANCE_JOB_STOP_RUN_ID =
  '9cebf290-185a-41d9-921f-8e3e737ae40d';
export const ACCEPTANCE_JOB_STOP_CLI_TASK_ID =
  'b789ebb2-bac4-4a45-9695-766a0b79e2ff';
export const ACCEPTANCE_JOB_STOP_WRAPPER_TASK_ID =
  '1b47c4b1-911c-4740-ad6a-ec8fa43acda9';

export const ACCEPTANCE_JOB_STOP_ACTIVE_TASKS = {
  tasks: [
    {
      id: ACCEPTANCE_JOB_STOP_CLI_TASK_ID,
      taskId: ACCEPTANCE_JOB_STOP_CLI_TASK_ID,
      kind: 'cli',
      runtime: 'cli',
      status: 'running',
      sessionKey: ACCEPTANCE_JOB_STOP_CHILD_SESSION_KEY,
      childSessionKey: ACCEPTANCE_JOB_STOP_CHILD_SESSION_KEY,
      ownerKey: ACCEPTANCE_JOB_STOP_CHILD_SESSION_KEY,
      runId: ACCEPTANCE_JOB_STOP_RUN_ID,
      sourceId: ACCEPTANCE_JOB_STOP_RUN_ID,
      createdAt: 1_785_527_040_955,
      updatedAt: 1_785_527_062_909,
      startedAt: 1_785_527_042_155,
    },
    {
      id: ACCEPTANCE_JOB_STOP_WRAPPER_TASK_ID,
      taskId: ACCEPTANCE_JOB_STOP_WRAPPER_TASK_ID,
      kind: 'subagent',
      runtime: 'subagent',
      status: 'running',
      sessionKey: 'agent:main:project-6a04c754',
      childSessionKey: ACCEPTANCE_JOB_STOP_CHILD_SESSION_KEY,
      ownerKey: 'agent:main:project-6a04c754',
      runId: ACCEPTANCE_JOB_STOP_RUN_ID,
      flowId: '7db4bd19-36ee-4db6-af5c-ec0ae0037425',
      sourceId: ACCEPTANCE_JOB_STOP_RUN_ID,
      createdAt: 1_785_527_040_942,
      updatedAt: 1_785_527_062_909,
      startedAt: 1_785_527_042_155,
    },
  ],
} as const;

/** Exact post-cancel OC task truth from the same real run. */
export const ACCEPTANCE_JOB_STOP_TERMINAL_TASKS = {
  tasks: [
    {
      ...ACCEPTANCE_JOB_STOP_ACTIVE_TASKS.tasks[0],
      status: 'timed_out',
      updatedAt: 1_785_527_068_372,
      endedAt: 1_785_527_069_193,
      terminalSummary: 'aborted',
    },
    {
      ...ACCEPTANCE_JOB_STOP_ACTIVE_TASKS.tasks[1],
      status: 'cancelled',
      updatedAt: 1_785_527_068_536,
      endedAt: 1_785_527_068_534,
      progressSummary: '3 tool call(s) made without visible output.',
      error: 'Cancelled from Research-Claw Jobs panel',
    },
  ],
} as const;

export const ACCEPTANCE_JOB_STOP_TERMINAL_SESSION = {
  key: ACCEPTANCE_JOB_STOP_CHILD_SESSION_KEY,
  sessionId: 'cb923283-fe64-4e39-8bbc-7fb1b3c562c9',
  abortedLastRun: true,
  status: 'done',
  subagentRunState: 'historical',
  hasActiveSubagentRun: false,
  startedAt: 1_785_527_040_942,
  endedAt: 1_785_527_068_372,
  runtimeMs: 26_217,
  parentSessionKey: 'agent:main:project-6a04c754',
  hasActiveRun: false,
} as const;

/**
 * Exact tool-call sequence from real foreground Run
 * `3ed96a69-b7cb-42c6-af74-cfbc084c26f5`. The RC hook rejected the model's
 * long poll and told it to create a persistent Job; the model then launched a
 * duplicate `sleep 420`. This is retained as evidence for the runtime policy
 * regression, even though these are agent tool payloads rather than WS frames.
 */
export const ACCEPTANCE_FOREGROUND_POLL_REQUEST = {
  toolName: 'process',
  params: {
    action: 'poll',
    sessionId: 'nimble-pine',
    timeout: 430_000,
  },
} as const;

export const ACCEPTANCE_FOREGROUND_POLL_BLOCK = {
  status: 'blocked',
  deniedReason: 'plugin-before-tool-call',
  reason:
    'Blocked: process.poll timeout exceeds 15 seconds. Create/update a persistent job, ' +
    'return control to the user, and check job_status in a later turn.',
} as const;

export const ACCEPTANCE_DUPLICATE_FOREGROUND_EXEC = {
  toolName: 'exec',
  params: {
    command: 'sleep 420 && echo "DONE"',
    timeout: 480,
    yieldMs: 430_000,
  },
} as const;

/** Exact identity/schema for the foreground process event that leaked A → B. */
export const ACCEPTANCE_SESSION_A_TOOL_START = {
  runId: '3ed96a69-b7cb-42c6-af74-cfbc084c26f5',
  sessionKey: 'agent:main:project-58f153dd',
  stream: 'tool',
  data: {
    phase: 'start',
    toolCallId: 'call_00_EHCmmeNVgq2YAnl54kqb7203',
    name: 'exec',
  },
} as const;

export const ACCEPTANCE_SESSION_B_KEY = 'project-9a918028';

/**
 * Exact lower-specificity item frame observed immediately after a real
 * `process` tool-start frame. It describes the same tool item, so it must not
 * erase the more useful current-tool activity that arrived first.
 */
export const ACCEPTANCE_FOREGROUND_ITEM_START_AFTER_TOOL = {
  runId: '1eb1e5bc-8bf2-44ce-9fd5-ed685bb25da1',
  sessionKey: 'agent:main:project-69e52e76',
  stream: 'item',
  data: {
    itemId: 'call_00_WGNNZMA9WTKBE8EUd8Sp5847',
    phase: 'start',
    kind: 'tool',
    title: 'process',
    status: 'running',
    name: 'process',
    toolCallId: 'call_00_WGNNZMA9WTKBE8EUd8Sp5847',
    startedAt: 1_785_528_442_694,
  },
} as const;

/** Exact F5 / >360s / final Session truth from the real long foreground Run. */
export const ACCEPTANCE_LONG_420_SESSION_KEY = 'agent:main:project-58f153dd';
export const ACCEPTANCE_LONG_420_SESSION_ID =
  'e6489668-bb31-4d59-950a-01bc817d22c6';
export const ACCEPTANCE_LONG_420_V2_RUN_ID =
  '3ed96a69-b7cb-42c6-af74-cfbc084c26f5';

export const ACCEPTANCE_LONG_420_F5_HISTORY_ACTIVE = {
  messages: [
    {
      role: 'user',
      timestamp: 1_785_527_155_941,
      idempotencyKey: `${ACCEPTANCE_LONG_420_V2_RUN_ID}:user`,
    },
  ],
  sessionInfo: {
    key: ACCEPTANCE_LONG_420_SESSION_KEY,
    sessionId: ACCEPTANCE_LONG_420_SESSION_ID,
    status: 'running',
    hasActiveRun: true,
    startedAt: 1_785_527_156_967,
    updatedAt: 1_785_527_439_105,
  },
  inFlightRun: {
    runId: ACCEPTANCE_LONG_420_V2_RUN_ID,
    text: '',
  },
} as const;

export const ACCEPTANCE_LONG_420_AFTER_360_ACTIVE = {
  key: ACCEPTANCE_LONG_420_SESSION_KEY,
  sessionId: ACCEPTANCE_LONG_420_SESSION_ID,
  status: 'running',
  hasActiveRun: true,
  startedAt: 1_785_527_156_967,
  updatedAt: 1_785_527_528_513,
} as const;

export const ACCEPTANCE_LONG_420_FINAL = {
  key: ACCEPTANCE_LONG_420_SESSION_KEY,
  sessionId: ACCEPTANCE_LONG_420_SESSION_ID,
  runId: ACCEPTANCE_LONG_420_V2_RUN_ID,
  status: 'done',
  startedAt: 1_785_527_156_967,
  endedAt: 1_785_527_602_013,
  runtimeMs: 445_046,
} as const;

export const ACCEPTANCE_SESSION_B_FINAL = {
  key: 'agent:main:project-9a918028',
  sessionId: 'c4a1162f-bcf3-4eb9-860c-130b5a72c75c',
  runId: '3d5a09d1-ea91-42da-838e-7fcc9a9f13de',
  status: 'done',
  startedAt: 1_785_527_504_909,
  endedAt: 1_785_527_506_895,
  runtimeMs: 1_986,
} as const;

/**
 * Exact `chat.history.sessionInfo` returned after the real Gateway restart.
 * The active registry was empty after restart, while the last persisted
 * session status had not yet advanced from `running`.
 */
export const ACCEPTANCE_GATEWAY_RESTART_STALE_RUNNING = {
  key: 'agent:main:project-29560714',
  sessionId: '4d25a8f3-eb6e-4d14-a29b-0414682f8863',
  status: 'running',
  hasActiveRun: false,
  startedAt: 1_785_528_789_553,
  updatedAt: 1_785_528_804_535,
} as const;
