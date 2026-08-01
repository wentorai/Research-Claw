import type { ChatMessage } from '../gateway/types';

export interface RunPresentationOwner {
  index: number;
  runId: string;
  noFinal: boolean;
}

export function runIdFromUserMessage(message: ChatMessage): string | null {
  if (message.role !== 'user' || typeof message.idempotencyKey !== 'string') return null;
  if (!message.idempotencyKey.endsWith(':user')) return null;
  const runId = message.idempotencyKey.slice(0, -':user'.length);
  return runId || null;
}

/**
 * One canonical owner per Run. The presence of a final assistant binding moves
 * ownership atomically in the same render; the earlier user turn is never also
 * returned, so live completion cannot flash duplicate cards.
 */
export function resolveRunPresentationOwners(messages: ChatMessage[]): RunPresentationOwner[] {
  const finalOwners = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.executionRunId) {
      finalOwners.set(message.executionRunId, index);
    }
  });
  const owners = new Map<string, RunPresentationOwner>();
  for (const [runId, index] of finalOwners) owners.set(runId, { index, runId, noFinal: false });
  messages.forEach((message, index) => {
    const runId = runIdFromUserMessage(message);
    if (runId && !owners.has(runId)) owners.set(runId, { index, runId, noFinal: true });
  });
  return [...owners.values()].sort((a, b) => a.index - b.index);
}
