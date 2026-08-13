import type { PanelTab } from '../stores/ui';

type PanelShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'keyCode' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'
>;

/** Resolve Ctrl+1..9 against the already policy-filtered visible tab list. */
export function resolvePanelShortcut<T extends PanelTab>(
  event: PanelShortcutEvent,
  visibleTabs: readonly T[],
): T | null {
  // keyCode 229 covers older Chromium/IME paths where isComposing is false on
  // the final keydown that merely accepts a CJK candidate.
  if (event.isComposing || event.keyCode === 229) return null;
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  return visibleTabs[Number(event.key) - 1] ?? null;
}
