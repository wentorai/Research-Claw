export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
> & {
  getModifierState?: (key: string) => boolean;
};

function hasControlModifier(event: ShortcutKeyEvent): boolean {
  if (event.getModifierState?.('Control')) return true;
  return event.ctrlKey;
}

function hasMetaModifier(event: ShortcutKeyEvent): boolean {
  if (event.getModifierState?.('Meta')) return true;
  return event.metaKey;
}

/** Escape — works on all platforms; not stolen by copy/paste semantics. */
export function isEscapeAbortShortcut(event: ShortcutKeyEvent): boolean {
  return event.key === 'Escape' && !hasControlModifier(event) && !hasMetaModifier(event) && !event.altKey && !event.shiftKey;
}

/**
 * Stop-generation shortcut: Escape ONLY, on every platform.
 *
 * Ctrl+C / ⌘C / ⌘. were removed on purpose — they collided with copy (the
 * selection guard only covered input/textarea targets, so copying streamed
 * assistant text aborted the run instead). Do not re-add them.
 */
export function isAbortGenerationShortcut(event: ShortcutKeyEvent): boolean {
  return isEscapeAbortShortcut(event);
}

/** Human-readable label for tooltips. */
export function abortChatShortcutLabel(): string {
  return 'Esc';
}
