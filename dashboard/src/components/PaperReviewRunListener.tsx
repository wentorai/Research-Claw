/**
 * Listens for cron review run failures (agent lifecycle + chat error events).
 */

import { useEffect } from 'react';
import { useGatewayStore } from '../stores/gateway';
import { usePaperReviewStore } from '../stores/paper-review';

export default function PaperReviewRunListener() {
  const client = useGatewayStore((s) => s.client);
  const handleAgentEvent = usePaperReviewStore((s) => s.handleAgentEvent);
  const handleChatEvent = usePaperReviewStore((s) => s.handleChatEvent);

  useEffect(() => {
    if (!client) return;

    const unsubAgent = client.subscribe('agent', handleAgentEvent);
    const unsubChat = client.subscribe('chat', handleChatEvent);
    return () => {
      unsubAgent();
      unsubChat();
    };
  }, [client, handleAgentEvent, handleChatEvent]);

  return null;
}
