import { useChatStore } from '../stores/chat';

/** True while a user-initiated chat run is in flight (matches when stop should be available). */
export function isActiveChatRun(): boolean {
  const s = useChatStore.getState();
  return Boolean(s.runId) || s.sending || s.streaming;
}
