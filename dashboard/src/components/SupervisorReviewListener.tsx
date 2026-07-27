import { useEffect } from 'react';
import { useGatewayStore } from '../stores/gateway';
import { useSupervisorStore } from '../stores/supervisor';

export default function SupervisorReviewListener() {
  const client = useGatewayStore((state) => state.client);

  useEffect(() => {
    if (!client?.isConnected) return;
    const hydrateFromDatabase = () => {
      const supervisor = useSupervisorStore.getState();
      void Promise.all([
        supervisor.loadStatus(),
        supervisor.loadAuditLog({ limit: 200 }),
      ]);
    };

    // Initial hydration also gives the plugin this live connection's gateway
    // request context, whose broadcast function is used only as a change signal.
    hydrateFromDatabase();
    const unsubscribe = client.subscribe('plugin.supervisor.review.updated', () => {
      hydrateFromDatabase();
    });
    return unsubscribe;
  }, [client]);

  return null;
}
