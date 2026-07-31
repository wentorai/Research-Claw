export interface ToolCallIntervention {
  block: true;
  blockReason: string;
}

/**
 * RC deliberately does not override OC's `process.poll` wait contract.
 *
 * Locked OC 2026.6.1 clamps each poll to 30 seconds in
 * `src/agents/bash-tools.process.ts`, so a model-supplied larger timeout does
 * not monopolize a chat turn indefinitely. Blocking that request at the RC
 * hook caused the model to launch the same command again and encouraged an
 * unrequested detached Job. Foreground/background intent belongs to the user
 * and Dashboard confirmation, not to a tool-timeout rule.
 */
export function processPollIntervention(
  _toolName: string | undefined,
  _params: Record<string, unknown> | undefined,
): ToolCallIntervention | null {
  return null;
}

/**
 * Repeating `process.poll` is OC's normal bounded-wait protocol, not evidence
 * of a model loop. The generic duplicate-call guard must therefore leave poll
 * cadence to OC while continuing to protect other tool calls.
 */
export function isToolDedupEligible(
  toolName: string | undefined,
  params: Record<string, unknown> | undefined,
): boolean {
  return !(toolName === 'process' && params?.action === 'poll');
}
