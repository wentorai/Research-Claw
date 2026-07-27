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
    // IME composition guard (CJK input). Escape is ALSO the standard "dismiss
    // the candidate window" key for every CJK IME, and this listener runs in the
    // capture phase with stopImmediatePropagation() — so without this guard a
    // Chinese user typing their next message while the agent streams would kill
    // the run just by closing the candidate list, with no way for the IME to
    // recover the keystroke. keyCode 229 is the secondary signal Chrome reports
    // during composition when isComposing is unavailable.
    if (e.isComposing || e.keyCode === 229) return;
    if (!isActiveChatRun()) return;
    if (!isAbortGenerationShortcut(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    useChatStore.getState().abort();
  };

  window.addEventListener('keydown', onKeyDown, true);
}
