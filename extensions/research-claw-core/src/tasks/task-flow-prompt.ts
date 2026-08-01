type PromptBuildEvent = {
  prompt?: unknown;
  messages?: unknown[];
};

const AUTO_LONG_TASK_MARKER = '[Research-Claw] Auto Long Task';
const TASK_COMPLETION_MARKER = '[Internal task completion event]';
const AUTO_LONG_TASK_JOB_ID_RE = /(?:^|\n)\s*-\s*Job ID:\s*(longtask:[^\s]+)/i;

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const block = item as Record<string, unknown>;
        return typeof block.text === 'string'
          ? block.text
          : typeof block.content === 'string'
            ? block.content
            : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function messageText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return contentText((value as { content?: unknown }).content);
}

export function findLatestAutoLongTaskJobId(messages: unknown[] = []): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index]);
    if (!text.includes(AUTO_LONG_TASK_MARKER)) continue;
    const match = text.match(AUTO_LONG_TASK_JOB_ID_RE);
    if (match?.[1]) return match[1];
  }
  return null;
}

function buildCompletionBoundary(jobId: string): string {
  return `[Research-Claw] Current subagent-completion boundary:
- This completion belongs only to Job ID \`${jobId}\`.
- In OpenClaw's completion instruction, "the original task" means only the exact user request carrying this Job ID. It never means an earlier transcript request.
- A user turn whose assistant response ended with \`stopReason: aborted\`, or which the user stopped in the Dashboard, is not pending work. Never reinterpret, resume, or call tools for it unless the user sends a new explicit request.
- First call \`job_status\` with this exact Job ID. If it is already terminal, do not call \`job_finish\` again. Report only this Job's observed child result and return control to the user.
- Do not call tools unrelated to this Job's exact request during the completion turn.`;
}

/** Injected via before_prompt_build — agents auto-report progress on multi-step work. */
export const TASK_FLOW_AGENT_GUIDANCE = `[Research-Claw] Long or multi-step work:
- Automatically break the task into 2–6 major steps before executing (do not ask the user to choose a "mode").
- Call \`task_flow_stage\` at the start and end of each step so the dashboard shows live progress.
- Keep each step's model output focused — avoid one giant final generation when work can be split.
- Create detached background work only when the user explicitly requested background or asynchronous execution, or when the message contains \`[Research-Claw] Auto Long Task\` after Dashboard confirmation. Otherwise keep the run in the foreground even when it is long or multi-step.
- If the user message contains \`[Research-Claw] Auto Long Task\` and a Job ID, do not call \`job_start\`; reuse that exact Job ID, spawn a child with \`sessions_spawn\`, and have the child call \`job_checkpoint\`/\`job_finish\` for that Job ID.
- For a Research-Claw Job interrupted by a gateway reload, child failure, or completion announcement, call \`job_status\` before resuming any work. If its status is \`cancelled\`, treat that durable state as the user's Stop command: do not resume it, do not replace it with another subagent, and do not continue the cancelled work in the foreground. Briefly confirm that it remains stopped and return control to the user.
- Report only observed stage transitions. Do not estimate progress or remaining time.
- Treat production DBs, provider config, MEMORY.md, bootstrap files, and workspace roots as read-only unless the user explicitly approved that exact write.
- Do not write to the literature library for exploratory requests. Calls to \`library_add_paper\` or \`library_batch_add\` require explicit save intent such as "入库", "保存到文库", "加入文库", "添加到 library", or "记录下来". For "找一下", "检索", "推荐", "列出", or "有哪些" requests, search and present candidates first, then ask before adding.
- For a specialized research method, reporting guideline, domain workflow, literature task, analysis task, or writing-tool request, call \`skill_search\` with the most diagnostic terms, call \`skill_load\` exactly one time for the best leaf Skill, and do not read generic SKILL.md files first or load several Skills for comparison.
- When structured Tool Search projects the tools, call \`tool_search\` with the exact query \`skill_search\`, invoke the returned stable tool ID, then repeat with the exact query \`skill_load\`. Never wrap a \`tool_call\` inside another \`tool_call\`.
- Route product work through Research-Claw/OpenClaw tools first: \`task_*\`/\`job_*\`, \`library_*\` or \`rc.lit.*\`, \`workspace_*\`, \`config.patch\`/\`config.apply\`, \`memory_*\`, \`skill_search\`, and Research-Plugins APIs. If the required tool is unavailable, stop and report instead of mutating raw files or DBs.
- Subagents must not create unrelated jobs, rerun onboarding/bootstrap, update global memory, change provider config, restart gateways, install packages, or run git operations.
- Resume from the latest checkpoint; do not restart completed batches unless the user requests it.
- Finish non-trivial jobs by following the Self-Check Agent guidance: verify scope, tool results, writes made, checkpoint/resume state, and remaining risks before final output.
- For foreground work, continue the same run with OpenClaw-bounded \`process.poll\` calls until the existing process finishes or the user stops it. Do not start the same command again while its process session is active.
- Never create a detached Job merely because an \`exec\` command is still running. Detached Jobs still require explicit user intent or prior Dashboard confirmation; for an already detached Job, return control and use \`job_status\` in a later turn.
- A timed-out chat run does not mean a background job failed. Report the persistent job status accurately.
- Use concise step labels (≤12 words). Skip for trivial one-shot replies.`;

/**
 * Add a per-Job completion boundary only on the real OpenClaw push-announcement
 * path. This prevents OC's generic "original task" wording from reviving a
 * different, previously aborted user turn in the same transcript.
 */
export function buildTaskFlowAgentGuidance(event: unknown = {}): string {
  const promptEvent: PromptBuildEvent =
    event && typeof event === 'object' ? (event as PromptBuildEvent) : {};
  const prompt = typeof promptEvent.prompt === 'string' ? promptEvent.prompt : '';
  if (!prompt.includes(TASK_COMPLETION_MARKER)) return TASK_FLOW_AGENT_GUIDANCE;

  const jobId = findLatestAutoLongTaskJobId(promptEvent.messages);
  if (!jobId) return TASK_FLOW_AGENT_GUIDANCE;
  return `${TASK_FLOW_AGENT_GUIDANCE}\n${buildCompletionBoundary(jobId)}`;
}
