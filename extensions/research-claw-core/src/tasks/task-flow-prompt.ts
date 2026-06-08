/** Injected via before_prompt_build — agents auto-report progress on multi-step work. */
export const TASK_FLOW_AGENT_GUIDANCE = `[Research-Claw] Long or multi-step work:
- Automatically break the task into 2–6 major steps before executing (do not ask the user to choose a "mode").
- Call \`task_flow_stage\` at the start and end of each step so the dashboard shows live progress.
- Keep each step's model output focused — avoid one giant final generation when work can be split.
- Use concise step labels (≤12 words). Skip for trivial one-shot replies.`;
