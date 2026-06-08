import { useChatStore } from '../stores/chat';
import { isAbortGenerationShortcut } from './keyboard-shortcut';
import { isActiveChatRun } from './chat-run';

let installed = false;

/**
 * Register global stop shortcuts once at app bootstrap (before React tree).
 * Served builds at :28789 use dashboard/dist — rebuild after changing this file.
 */
export function installChatAbortKeyboardShortcuts(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isActiveChatRun()) return;
    if (!isAbortGenerationShortcut(e, e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    useChatStore.getState().abort();
  };

  window.addEventListener('keydown', onKeyDown, true);
}
