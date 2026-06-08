export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
> & {
  getModifierState?: (key: string) => boolean;
};

/**
 * Detect macOS for keyboard shortcut labeling and behavior.
 */
export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform ?? '';
  const ua = navigator.userAgent ?? '';
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  if (uaPlatform) {
    return uaPlatform === 'macOS';
  }
  return /Mac|iPhone|iPad|iPod/i.test(platform) || /Mac OS X/i.test(ua);
}

function hasControlModifier(event: ShortcutKeyEvent): boolean {
  if (event.getModifierState?.('Control')) return true;
  return event.ctrlKey;
}

function hasMetaModifier(event: ShortcutKeyEvent): boolean {
  if (event.getModifierState?.('Meta')) return true;
  return event.metaKey;
}

function isKeyC(event: ShortcutKeyEvent): boolean {
  return event.key?.toLowerCase() === 'c' || event.code === 'KeyC';
}

function isPeriodKey(event: ShortcutKeyEvent): boolean {
  return event.key === '.' || event.code === 'Period';
}

/** Escape — works on all platforms; not stolen by copy/paste semantics. */
export function isEscapeAbortShortcut(event: ShortcutKeyEvent): boolean {
  return event.key === 'Escape' && !hasControlModifier(event) && !hasMetaModifier(event) && !event.altKey && !event.shiftKey;
}

/**
 * Stop-generation shortcut (platform-specific).
 *
 * - macOS: ⌃C, ⌘., or ⌘C (when not copying a selection)
 * - Windows/Linux: Ctrl+C
 */
export function isAbortChatShortcut(event: ShortcutKeyEvent): boolean {
  if (event.altKey || event.shiftKey) return false;

  if (isMacOS()) {
    if (hasControlModifier(event) && !hasMetaModifier(event) && isKeyC(event)) return true;
    if (hasMetaModifier(event) && !hasControlModifier(event) && isPeriodKey(event)) return true;
    return false;
  }

  return hasControlModifier(event) && !hasMetaModifier(event) && isKeyC(event);
}

/**
 * macOS ⌘C to stop when there is no text selection (⌘C remains copy when selecting).
 */
export function isMacCommandCAbort(event: ShortcutKeyEvent, target: EventTarget | null): boolean {
  if (!isMacOS() || hasControlModifier(event) || event.altKey || event.shiftKey) return false;
  if (!hasMetaModifier(event) || !isKeyC(event)) return false;

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (start != null && end != null && start !== end) return false;
  }
  return true;
}

export function isAbortGenerationShortcut(
  event: ShortcutKeyEvent,
  target: EventTarget | null,
): boolean {
  if (isEscapeAbortShortcut(event)) return true;
  return isAbortChatShortcut(event) || isMacCommandCAbort(event, target);
}

/** Human-readable label for tooltips (platform-specific). */
export function abortChatShortcutLabel(): string {
  return isMacOS() ? 'Esc / ⌃C / ⌘.' : 'Esc / Ctrl+C';
}
