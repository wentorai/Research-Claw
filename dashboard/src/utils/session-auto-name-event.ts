import type { ChatStreamEvent } from '../gateway/types';

/**
 * Return the exact session whose completed turn may need an automatic title.
 * This stays independent of the dashboard's active session so A finishing
 * while B is visible cannot rename B.
 */
export function autoNameSessionKeyForEvent(event: ChatStreamEvent): string | null {
  return event.state === 'final' && event.sessionKey ? event.sessionKey : null;
}
