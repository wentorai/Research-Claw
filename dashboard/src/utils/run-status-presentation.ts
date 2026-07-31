import type { ConnectionState } from '../gateway/types';
import type { RunActivityKind, SessionRunView } from '../stores/session-runs';

export type RunStatusPresentationKind =
  | 'reconnecting'
  | 'stopping'
  | 'submitting'
  | 'accepted'
  | 'confirming-submit'
  | 'compacting'
  | 'tool'
  | 'fallback'
  | 'streaming'
  | 'continuing'
  | 'processing'
  | 'confirming-result'
  | 'result-unconfirmed'
  | 'done'
  | 'killed'
  | 'timeout'
  | 'failed'
  | 'interrupted';

export interface RunStatusPresentation {
  kind: RunStatusPresentationKind;
  isTerminal: boolean;
  spins: boolean;
  activityLabel?: string;
}

type RunPresentationInput = Pick<
  SessionRunView,
  | 'command'
  | 'lifecycle'
  | 'serverActive'
  | 'needsResultConfirmation'
  | 'resultUnconfirmed'
  | 'activity'
>;

interface ObservedAgentEvent {
  stream?: string;
  state?: string;
  data?: { phase?: string; name?: string; toolName?: string };
}

/** Map real OC agent event fields without keeping a completed tool as current. */
export function resolveObservedRunActivity(
  event: ObservedAgentEvent,
): { kind: RunActivityKind; label: string } | null {
  const phase = event.data?.phase;
  // OC emits lower-specificity item/command_output frames immediately after
  // the corresponding tool frame. They are partial observations of the same
  // activity and must not erase an already-known current tool name.
  if (
    event.stream
    && event.stream !== 'tool'
    && event.stream !== 'compaction'
    && event.stream !== 'lifecycle'
    && !event.state
  ) {
    return null;
  }
  const toolStillActive = event.stream === 'tool'
    && phase !== 'end'
    && phase !== 'result'
    && phase !== 'error';
  const kind: RunActivityKind = event.stream === 'compaction' && phase !== 'end'
    ? 'compacting'
    : event.stream === 'lifecycle' && (phase === 'fallback' || phase === 'fallback_step')
      ? 'fallback'
      : toolStillActive
        ? 'tool'
        : event.state === 'streaming'
          ? 'streaming'
          : 'processing';
  const toolName = event.data?.name ?? event.data?.toolName;
  return { kind, label: kind === 'tool' ? (toolName ?? kind) : kind };
}

/** Keep the useful identity of a tool while dropping params, paths and MCP namespaces. */
export function sanitizeRunActivityLabel(raw: string): string | undefined {
  const command = raw.trim().split(/\s+/, 1)[0] ?? '';
  const segments = command.split(/__|[.:/\\]/).filter(Boolean);
  const leaf = (segments.at(-1) ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
  if (!leaf) return undefined;
  return leaf.slice(0, 32);
}

/**
 * Convert transport + OC Session truth + observed activity into user-facing
 * state. This function never infers failure, progress or remaining time from
 * the absence of chat deltas.
 */
export function resolveRunStatusPresentation(
  run: RunPresentationInput,
  transport: ConnectionState,
): RunStatusPresentation | null {
  // An already-observed OC terminal is stronger than every transport, command,
  // registry or activity projection.
  switch (run.lifecycle) {
    case 'done':
      return { kind: 'done', isTerminal: true, spins: false };
    case 'killed':
      return { kind: 'killed', isTerminal: true, spins: false };
    case 'timeout':
      return { kind: 'timeout', isTerminal: true, spins: false };
    case 'failed':
      return { kind: 'failed', isTerminal: true, spins: false };
    case 'interrupted':
      return { kind: 'interrupted', isTerminal: true, spins: false };
  }

  if (transport !== 'connected') {
    return { kind: 'reconnecting', isTerminal: false, spins: true };
  }
  if (run.command === 'stopping') {
    return { kind: 'stopping', isTerminal: false, spins: true };
  }
  if (run.command === 'ack_unknown') {
    return { kind: 'confirming-submit', isTerminal: false, spins: true };
  }
  if (run.command === 'submitting') {
    return { kind: 'submitting', isTerminal: false, spins: true };
  }
  if (run.needsResultConfirmation) {
    return { kind: 'confirming-result', isTerminal: false, spins: false };
  }
  if (run.resultUnconfirmed) {
    return { kind: 'result-unconfirmed', isTerminal: false, spins: false };
  }
  if (run.command === 'accepted') {
    return { kind: 'accepted', isTerminal: false, spins: true };
  }

  if (run.serverActive) {
    switch (run.activity?.kind) {
      case 'compacting':
        return { kind: 'compacting', isTerminal: false, spins: true };
      case 'tool':
        return {
          kind: 'tool',
          isTerminal: false,
          spins: true,
          activityLabel: sanitizeRunActivityLabel(run.activity.label),
        };
      case 'fallback':
        return { kind: 'fallback', isTerminal: false, spins: true };
      case 'streaming':
        return { kind: 'streaming', isTerminal: false, spins: true };
      case 'finalizing':
        return { kind: 'continuing', isTerminal: false, spins: true };
      default:
        return { kind: 'processing', isTerminal: false, spins: true };
    }
  }

  return null;
}
