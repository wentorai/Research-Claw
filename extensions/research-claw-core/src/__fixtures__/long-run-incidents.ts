/**
 * Exact agent tool payload from real foreground Run
 * `3ed96a69-b7cb-42c6-af74-cfbc084c26f5` on 2026-08-01.
 *
 * Kept inside the extension root because its build intentionally rejects
 * cross-root test imports. The Dashboard fixture retains the corresponding
 * UI/session wire evidence.
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

/**
 * Exact transcript sequence from parent session
 * `2b831ea9-e0a8-4782-8d24-338488f02b37` on 2026-08-01.
 *
 * OpenClaw's push announcement used its generic "original task" instruction.
 * Without a per-Job boundary the parent revived the earlier aborted paper
 * request and called workspace_list after the unrelated sleep Job completed.
 */
export const ACCEPTANCE_ABORTED_PREDECESSOR_MESSAGES = [
  {
    role: 'user',
    content: '帮我批量整理 workspace 里的论文，生成一份报告。',
  },
  {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'The user wants me to batch-organize papers.' }],
    stopReason: 'aborted',
    errorMessage: 'Request was aborted',
  },
  {
    role: 'user',
    content: `请放到后台用子 Agent 执行：调用 shell sleep 15，完成后只回复 BACKGROUND_JOB_OK。

[Research-Claw] Auto Long Task
  - This request has been promoted to a tracked background job.
  - Job ID: longtask:eeda758f-1a98-430c-9899-3c534a45c1b9
  - Job title: 后台任务: 放到后台用子 Agent 执行：调用 shell sleep 15，完成后只回复 BACKGROUND_JOB_...
  - Referenced files: none`,
  },
] as const;

export const ACCEPTANCE_SUBAGENT_COMPLETION_PROMPT = `[Internal task completion event]
source: subagent
session_key: agent:main:subagent:6cddd127-2ed0-4599-92b1-7e2a226614b2
session_id: fb632ba5-f91b-43f0-8e80-282b6566599a
type: subagent task
task: background-sleep
status: completed; ready for parent review

Action:
A completed subagent task is ready for parent review. Review/verify the result above before deciding whether the original task is done.`;

export const ACCEPTANCE_RESURRECTED_TOOL_CALL = {
  name: 'workspace_list',
  arguments: { recursive: true },
} as const;
